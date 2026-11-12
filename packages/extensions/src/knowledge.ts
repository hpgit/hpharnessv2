import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  statSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
/** Physical quota includes original blobs, SQLite, WAL, vectors and other collection caches. */
export class KnowledgeStore {
  private db: DatabaseSync;
  constructor(
    private root: string,
    private limit = 50 * 1024 ** 3,
  ) {
    mkdirSync(join(root, "blobs"), { recursive: true });
    this.db = new DatabaseSync(join(root, "sources.db"));
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,project TEXT,title TEXT,origin TEXT,kind TEXT,digest TEXT,bytes INTEGER,text TEXT,created TEXT,metadata TEXT); CREATE TABLE IF NOT EXISTS texts(digest TEXT PRIMARY KEY,text TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,name TEXT,versions TEXT); CREATE TABLE IF NOT EXISTS links(project TEXT,asset TEXT,version TEXT,PRIMARY KEY(project,asset));`,
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(sources)")
        .all()
        .some((row) => row.name === "text_digest")
    )
      this.db.exec("ALTER TABLE sources ADD COLUMN text_digest TEXT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db
        .prepare(
          "SELECT id,text FROM sources WHERE text_digest IS NULL AND text<>''",
        )
        .all()) {
        const text = String(row.text),
          digest = createHash("sha256").update(text).digest("hex");
        this.db
          .prepare("INSERT OR IGNORE INTO texts VALUES (?,?)")
          .run(digest, text);
        this.db
          .prepare("UPDATE sources SET text_digest=?,text='' WHERE id=?")
          .run(digest, row.id!);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.checkpoint();
  }
  private checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  private allocated(path = this.root): number {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += this.allocated(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
    return total;
  }
  private usage() {
    return {
      bytes: this.allocated(),
      limit: this.limit,
      blobBytes: Number(
        this.db
          .prepare(
            "SELECT COALESCE(SUM(bytes),0) AS bytes FROM (SELECT digest,MAX(bytes) AS bytes FROM sources WHERE digest IS NOT NULL GROUP BY digest)",
          )
          .get()!.bytes,
      ),
    };
  }
  private ingest(p: any) {
    if (!p.source || !p.title || !p.projectId)
      throw new Error("Source, title and projectId are required");
    const input = p.base64
      ? Buffer.from(p.base64, "base64")
      : Buffer.from(p.text ?? "", "utf8");
    const unfetched =
      p.attachment && p.automatic && input.length > 20 * 1024 ** 2;
    const data = unfetched ? null : input,
      text = unfetched ? "" : String(p.text ?? "");
    const digest = data
        ? createHash("sha256").update(data).digest("hex")
        : null,
      textDigest = text
        ? createHash("sha256").update(text).digest("hex")
        : null;
    const metadata = JSON.stringify(
      unfetched
        ? { ...p.metadata, unfetched: true, originalBytes: input.length }
        : (p.metadata ?? {}),
    );
    const record = {
      id: randomUUID(),
      project: p.projectId,
      title: p.title,
      origin: p.source,
      kind: p.kind ?? (unfetched ? "attachment" : "document"),
      digest,
      bytes: data?.length ?? 0,
      text: "",
      created: new Date().toISOString(),
      metadata,
    };
    const blob = digest ? join(this.root, "blobs", digest) : null,
      newBlob = Boolean(blob && !existsSync(blob));
    const newText = Boolean(
      textDigest &&
        !this.db.prepare("SELECT 1 FROM texts WHERE digest=?").get(textDigest),
    );
    this.checkpoint();
    const expected =
      (newBlob ? data!.length : 0) +
      (newText ? Buffer.byteLength(text) : 0) +
      Buffer.byteLength(metadata) +
      Buffer.byteLength(String(p.title) + String(p.source)) +
      65536;
    if (this.usage().bytes + expected > this.limit)
      throw new Error("Collection quota reached; originals were preserved");
    let inserted = false;
    try {
      if (newBlob && blob && data) {
        const temporary = blob + "." + randomUUID() + ".tmp";
        writeFileSync(temporary, data);
        renameSync(temporary, blob);
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (textDigest)
          this.db
            .prepare("INSERT OR IGNORE INTO texts VALUES (?,?)")
            .run(textDigest, text);
        this.db
          .prepare(
            "INSERT INTO sources(id,project,title,origin,kind,digest,bytes,text,created,metadata,text_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(...Object.values(record), textDigest);
        this.db.exec("COMMIT");
        inserted = true;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.checkpoint();
      if (this.usage().bytes > this.limit)
        throw new Error("Collection quota reached; originals were preserved");
      return {
        ...record,
        text,
        ...(unfetched
          ? { state: "metadata_only", reason: "attachment_over_auto_limit" }
          : { state: "archived" }),
      };
    } catch (error) {
      if (inserted)
        this.db.prepare("DELETE FROM sources WHERE id=?").run(record.id);
      if (newText && textDigest)
        this.db
          .prepare(
            "DELETE FROM texts WHERE digest=? AND NOT EXISTS(SELECT 1 FROM sources WHERE text_digest=?)",
          )
          .run(textDigest, textDigest);
      if (
        newBlob &&
        blob &&
        existsSync(blob) &&
        !this.db.prepare("SELECT 1 FROM sources WHERE digest=?").get(digest!)
      )
        unlinkSync(blob);
      this.checkpoint();
      throw error;
    }
  }
  handle(method: string, p: any): any {
    if (["assets.create", "assets.version", "assets.link"].includes(method)) {
      this.checkpoint();
      const previous =
        method === "assets.version"
          ? this.db.prepare("SELECT versions FROM assets WHERE id=?").get(p.id)
          : undefined;
      const reserve =
        65536 +
        2 * Buffer.byteLength(JSON.stringify(p)) +
        2 * Buffer.byteLength(String(previous?.versions ?? ""));
      if (this.usage().bytes + reserve > this.limit)
        throw new Error(
          "Collection quota reached; asset metadata was preserved",
        );
    }
    if (method === "knowledge.usage") return this.usage();
    if (method === "knowledge.ingest") return this.ingest(p);
    if (method === "knowledge.ids")
      return this.db
        .prepare("SELECT id FROM sources WHERE (? IS NULL OR project=?)")
        .all(p.projectId ?? null, p.projectId ?? null)
        .map((row) => String(row.id));
    if (method === "knowledge.search")
      return this.db
        .prepare(
          "SELECT s.id,s.project,s.title,s.origin,s.kind,s.digest,s.created,COALESCE(t.text,s.text) AS text FROM sources s LEFT JOIN texts t ON t.digest=s.text_digest WHERE (? IS NULL OR s.project=?) AND (instr(lower(COALESCE(t.text,s.text)),lower(?))>0 OR instr(lower(s.title),lower(?))>0) ORDER BY s.created DESC LIMIT 100",
        )
        .all(
          p.projectId ?? null,
          p.projectId ?? null,
          p.query ?? "",
          p.query ?? "",
        );
    if (method === "knowledge.read" || method === "knowledge.metadata") {
      const source = this.db
        .prepare(
          "SELECT s.*,COALESCE(t.text,s.text) AS text FROM sources s LEFT JOIN texts t ON t.digest=s.text_digest WHERE s.id=?",
        )
        .get(p.id);
      if (!source) throw new Error("Source not found");
      if (method === "knowledge.metadata") return source;
      return {
        ...source,
        ...(source.digest
          ? {
              base64: readFileSync(
                join(this.root, "blobs", String(source.digest)),
              ).toString("base64"),
            }
          : { state: "metadata_only" }),
      };
    }
    if (method === "assets.create") {
      const asset = { id: randomUUID(), name: p.name, versions: [] };
      if (!p.name) throw new Error("Asset name required");
      this.db
        .prepare("INSERT INTO assets VALUES (?,?,?)")
        .run(asset.id, asset.name, "[]");
      return asset;
    }
    if (method === "assets.version") {
      const row = this.db.prepare("SELECT * FROM assets WHERE id=?").get(p.id);
      if (!row) throw new Error("Asset not found");
      if (!p.location || !p.digest)
        throw new Error("Version location and content digest required");
      const versions = JSON.parse(String(row.versions));
      const version = {
        id: randomUUID(),
        location: p.location,
        digest: p.digest,
        parent: p.parent ?? null,
        created: new Date().toISOString(),
      };
      versions.push(version);
      this.db
        .prepare("UPDATE assets SET versions=? WHERE id=?")
        .run(JSON.stringify(versions), p.id);
      return version;
    }
    if (method === "assets.link") {
      const row = this.db.prepare("SELECT * FROM assets WHERE id=?").get(p.id);
      if (
        !row ||
        !JSON.parse(String(row.versions)).some((v: any) => v.id === p.version)
      )
        throw new Error("Unknown asset version");
      this.db
        .prepare(
          "INSERT INTO links VALUES (?,?,?) ON CONFLICT(project,asset) DO UPDATE SET version=excluded.version",
        )
        .run(p.projectId, p.id, p.version);
      return { linked: true };
    }
    if (method === "assets.list")
      return this.db
        .prepare("SELECT * FROM assets")
        .all()
        .map((row) => ({
          ...row,
          versions: JSON.parse(String(row.versions)),
          projects: this.db
            .prepare("SELECT project,version FROM links WHERE asset=?")
            .all(row.id!),
        }));
    throw new Error("Unknown knowledge method");
  }
  close() {
    this.checkpoint();
    this.db.close();
  }
}
