#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod appearance;
mod interface;
mod rpc;
mod state;
mod terminal;

use eframe::egui::{self, Color32, RichText};
use serde_json::{Value, json};
use state::{Buffer, Preferences};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::{Duration, Instant},
};

fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().collect();
    let size = args
        .iter()
        .position(|s| s == "--smoke-size")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.split_once('x'))
        .and_then(|(w, h)| {
            Some([
                w.parse::<f32>().ok()?.clamp(850.0, 2560.0),
                h.parse::<f32>().ok()?.clamp(600.0, 1600.0),
            ])
        })
        .unwrap_or([1380.0, 900.0]);
    let options = eframe::NativeOptions {
        persist_window: !args.iter().any(|arg| arg == "--smoke-report"),
        persistence_path: args
            .iter()
            .position(|arg| arg == "--smoke-report")
            .and_then(|i| args.get(i + 1))
            .map(|path| PathBuf::from(path).with_extension("ui-state")),
        viewport: egui::ViewportBuilder::default()
            .with_inner_size(size)
            .with_min_inner_size([850.0, 600.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Harness",
        options,
        Box::new(|cc| Ok(Box::new(HarnessApp::new(cc)))),
    )
}

#[derive(Clone)]
enum Pending {
    Ping,
    Projects,
    AllSessions,
    Sessions(String),
    Messages(String),
    Runs,
    Approvals,
    Settings,
    CreateProject,
    CreateSession,
    Files(String),
    Read(String),
    Save { index: usize, submitted: String },
    Command,
    Memory,
    Generic(String),
    Silent,
    LspStart,
    LspResult(String, String, usize),
    LspCatalog,
    RunStart(String),
    Git,
    Inspector,
    Preview,
}

struct HarnessApp {
    markdown: egui_commonmark::CommonMarkCache,
    sidebar_query: String,
    search_open: bool,
    collapsed_projects: HashSet<String>,
    client: rpc::Client,
    pending: HashMap<u64, Pending>,
    prefs: Preferences,
    projects: Vec<Value>,
    sessions: Vec<Value>,
    all_sessions: Vec<Value>,
    messages: Vec<Value>,
    runs: Vec<Value>,
    approvals: Vec<Value>,
    memories: Vec<Value>,
    files: Vec<Value>,
    file_dir: String,
    buffers: Vec<Buffer>,
    active_buffer: usize,
    composer: String,
    command: String,
    terminal: String,
    status: String,
    connected: bool,
    left_tab: usize,
    bottom_open: bool,
    bottom_tab: usize,
    settings_open: bool,
    create_open: bool,
    memory_open: bool,
    new_project: String,
    new_root: String,
    new_host: String,
    new_container: String,
    remote: bool,
    settings: Value,
    protocol: String,
    endpoint: String,
    model: String,
    key_path: String,
    memory_text: String,
    memory_query: String,
    core_path: String,
    core_migrate: bool,
    last_poll: Instant,
    started: Instant,
    smoke_report: Option<PathBuf>,
    smoke_chat: bool,
    screenshot_requested: bool,
    advanced_settings: String,
    lsp_command: String,
    lsp_args: String,
    lsp_ready: bool,
    lsp_session: String,
    lsp_version: i64,
    lsp_open: HashMap<String, i64>,
    lsp_catalog: Vec<Value>,
    lsp_result: Value,
    lsp_kind: String,
    lsp_snapshot: String,
    lsp_cursor: usize,
    editor_cursor: usize,
    goto: Option<(String, usize, usize)>,
    pty: Option<terminal::Terminal>,
    pty_input: String,
    git_patch: String,
    git_output: String,
    rpc_method: String,
    rpc_params: String,
    rpc_output: String,
    smoke_scenario: Option<PathBuf>,
    smoke_phase: u8,
    smoke_completed: Option<Instant>,
    new_session_open: bool,
    new_session_title: String,
    image_rx: Option<std::sync::mpsc::Receiver<Result<(String, egui::ColorImage), String>>>,
    preview_image: Option<(String, egui::TextureHandle)>,
    preview_open: bool,
    preview_note: String,
    smoke_preview: Option<String>,
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn array(value: Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn workspace_root() -> PathBuf {
    if let Some(path) = std::env::var_os("HPH_ROOT") {
        return path.into();
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    for candidate in cwd.ancestors() {
        if candidate.join("packages/harness").exists() {
            return candidate.to_path_buf();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for candidate in exe.ancestors() {
            if candidate.join("packages/harness").exists() {
                return candidate.to_path_buf();
            }
        }
    }
    cwd
}

impl HarnessApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let mut fonts = egui::FontDefinitions::default();
        let font_path = std::env::var_os("HPH_FONT").map(PathBuf::from).or_else(|| {
            [
                "C:/Windows/Fonts/malgun.ttf",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
            ]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.exists())
        });
        if let Some(path) = font_path
            && let Ok(data) = std::fs::read(path)
        {
            fonts
                .font_data
                .insert("korean".into(), egui::FontData::from_owned(data).into());
            for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
                fonts
                    .families
                    .entry(family)
                    .or_default()
                    .push("korean".into());
            }
        }
        cc.egui_ctx.set_fonts(fonts);
        cc.egui_ctx.style_mut(|style| {
            style.spacing.item_spacing = egui::vec2(8.0, 8.0);
            style.spacing.button_padding = egui::vec2(10.0, 6.0);
            style
                .text_styles
                .insert(egui::TextStyle::Body, egui::FontId::proportional(15.0));
            style
                .text_styles
                .insert(egui::TextStyle::Button, egui::FontId::proportional(14.0));
            style
                .text_styles
                .insert(egui::TextStyle::Small, egui::FontId::proportional(12.0));
            style
                .text_styles
                .insert(egui::TextStyle::Monospace, egui::FontId::monospace(14.0));
        });
        let prefs = cc
            .storage
            .and_then(|s| eframe::get_value(s, "preferences"))
            .unwrap_or_default();
        let root = workspace_root();
        let args: Vec<_> = std::env::args_os().collect();
        let smoke_report = args
            .iter()
            .position(|a| a == "--smoke-report")
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from);
        let smoke_scenario = args
            .iter()
            .position(|a| a == "--smoke-scenario")
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from);
        let smoke_preview = args
            .iter()
            .position(|a| a == "--smoke-preview")
            .and_then(|i| args.get(i + 1))
            .map(|s| s.to_string_lossy().into_owned());
        let mut app = Self {
            markdown: egui_commonmark::CommonMarkCache::default(),
            sidebar_query: String::new(),
            search_open: false,
            client: rpc::Client::launch(&root, cc.egui_ctx.clone()),
            pending: HashMap::new(),
            prefs,
            projects: vec![],
            sessions: vec![],
            all_sessions: vec![],
            collapsed_projects: HashSet::new(),
            messages: vec![],
            runs: vec![],
            approvals: vec![],
            memories: vec![],
            files: vec![],
            file_dir: String::new(),
            buffers: vec![],
            active_buffer: 0,
            composer: String::new(),
            command: String::new(),
            terminal: String::new(),
            status: "실행 서비스 연결 중…".into(),
            connected: false,
            left_tab: 0,
            bottom_open: args.iter().any(|arg| arg == "--smoke-panel"),
            bottom_tab: 0,
            settings_open: false,
            create_open: false,
            memory_open: false,
            new_project: "내 프로젝트".into(),
            new_root: root.to_string_lossy().into_owned(),
            new_host: "wsl".into(),
            new_container: String::new(),
            remote: false,
            settings: json!({}),
            protocol: "responses".into(),
            endpoint: "http://localhost:10100/v1".into(),
            model: "gpt-6-luna".into(),
            key_path: String::new(),
            memory_text: String::new(),
            memory_query: String::new(),
            core_path: String::new(),
            core_migrate: false,
            advanced_settings: String::new(),
            lsp_command: "pyright-langserver".into(),
            lsp_args: "[\"--stdio\"]".into(),
            lsp_ready: false,
            lsp_session: String::new(),
            lsp_version: 0,
            lsp_open: HashMap::new(),
            lsp_catalog: vec![],
            lsp_result: Value::Null,
            lsp_kind: String::new(),
            lsp_snapshot: String::new(),
            lsp_cursor: 0,
            editor_cursor: 0,
            goto: None,
            pty: None,
            pty_input: String::new(),
            git_patch: String::new(),
            git_output: String::new(),
            rpc_method: "tools.list".into(),
            rpc_params: "{}".into(),
            rpc_output: String::new(),
            last_poll: Instant::now(),
            started: Instant::now(),
            smoke_report,
            smoke_chat: args.iter().any(|a| a == "--smoke-chat"),
            screenshot_requested: false,
            smoke_scenario,
            smoke_phase: 0,
            smoke_completed: None,
            new_session_open: false,
            new_session_title: "새 작업".into(),
            image_rx: None,
            preview_image: None,
            preview_open: false,
            preview_note: String::new(),
            smoke_preview,
        };
        let managed_pyright =
            root.join(".tools/languages/node_modules/pyright/langserver.index.js");
        if managed_pyright.exists() {
            app.lsp_command = std::env::var("HPH_NODE").unwrap_or_else(|_| "node".into());
            app.lsp_args = json!([managed_pyright.to_string_lossy(), "--stdio"]).to_string();
        }
        app.request("ping", json!({}), Pending::Ping);
        app.request("projects.list", json!({}), Pending::Projects);
        app.request("sessions.list", json!({}), Pending::AllSessions);
        app.request("settings.get", json!({}), Pending::Settings);
        app.request("lsp.catalog", json!({}), Pending::LspCatalog);
        app.buffers = cc
            .storage
            .and_then(|s| eframe::get_value(s, "buffers"))
            .unwrap_or_default();
        if app.smoke_report.is_some() {
            app.buffers.clear();
            app.prefs = Preferences::default();
        }
        if args.iter().any(|a| a == "--smoke-dark") {
            app.prefs.dark = true;
        }
        if args.iter().any(|a| a == "--smoke-solarized") {
            app.prefs.dark = false;
            app.prefs.solarized = true;
        }
        app
    }

    fn request(&mut self, method: &str, params: Value, pending: Pending) {
        match self.client.request(method, params) {
            Ok(id) => {
                self.pending.insert(id, pending);
            }
            Err(error) => self.status = error,
        }
    }
    fn select_project(&mut self, id: String) {
        if !self.prefs.selected_project.is_empty() {
            self.prefs
                .project_modes
                .insert(self.prefs.selected_project.clone(), self.prefs.edit_mode);
        }
        self.prefs.edit_mode = *self.prefs.project_modes.get(&id).unwrap_or(&false);
        self.prefs.selected_project = id.clone();
        self.prefs.selected_session.clear();
        self.sessions.clear();
        self.messages.clear();
        self.files.clear();
        self.request(
            "sessions.list",
            json!({"projectId":id}),
            Pending::Sessions(self.prefs.selected_project.clone()),
        );
    }
    fn select_session(&mut self, id: String) {
        self.prefs.selected_session = id.clone();
        self.file_dir.clear();
        self.files.clear();
        self.preview_open = false;
        self.messages.clear();
        self.request(
            "messages.list",
            json!({"sessionId":id}),
            Pending::Messages(id.clone()),
        );
        self.request("files.list", json!({"sessionId":id}), Pending::Files(id));
    }
    fn refresh(&mut self) {
        if self.search_open {
            self.request("sessions.list", json!({}), Pending::AllSessions);
        }
        if !self.prefs.selected_session.is_empty() {
            self.request(
                "messages.list",
                json!({"sessionId":self.prefs.selected_session}),
                Pending::Messages(self.prefs.selected_session.clone()),
            );
        }
        self.request("runs.status", json!({}), Pending::Runs);
        self.request("approvals.list", json!({}), Pending::Approvals);
    }
    fn drain(&mut self) {
        while let Ok(event) = self.client.rx.try_recv() {
            match event {
                rpc::Incoming::Error(error) => {
                    self.status = error;
                }
                rpc::Incoming::Message(message) => {
                    let Some(id) = message.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    let Some(pending) = self.pending.remove(&id) else {
                        continue;
                    };
                    if let Some(error) = message.get("error") {
                        self.status =
                            format!("{}: {}", text(error, "code"), text(error, "message"));
                        if let Pending::Save { index, .. } = pending
                            && let Some(buffer) = self.buffers.get_mut(index)
                        {
                            buffer.conflict = Some(self.status.clone());
                        }
                        if let Pending::RunStart(input) = pending {
                            if self.composer.is_empty() {
                                self.composer = input;
                            } else {
                                self.composer = format!("{input}\n{}", self.composer);
                            }
                        }
                        continue;
                    }
                    let result = message.get("result").cloned().unwrap_or(Value::Null);
                    match pending {
                        Pending::Ping => {
                            self.connected = true;
                            self.status = "실행 서비스 연결됨".into();
                        }
                        Pending::Projects => {
                            self.projects = array(result);
                            if !self.projects.is_empty() {
                                let id = if self
                                    .projects
                                    .iter()
                                    .any(|p| text(p, "id") == self.prefs.selected_project)
                                {
                                    self.prefs.selected_project.clone()
                                } else {
                                    text(&self.projects[0], "id").to_owned()
                                };
                                self.select_project(id);
                            }
                        }
                        Pending::AllSessions => self.all_sessions = array(result),
                        Pending::Sessions(project) => {
                            if project != self.prefs.selected_project {
                                continue;
                            }
                            self.sessions = array(result);
                            self.all_sessions
                                .retain(|s| text(s, "projectId") != project);
                            self.all_sessions.extend(self.sessions.clone());
                            if !self
                                .sessions
                                .iter()
                                .any(|s| text(s, "id") == self.prefs.selected_session)
                                && let Some(s) = self.sessions.first()
                            {
                                self.select_session(text(s, "id").into());
                            }
                        }
                        Pending::Messages(session) => {
                            if session == self.prefs.selected_session {
                                self.messages = array(result);
                            }
                        }
                        Pending::Runs => self.runs = array(result),
                        Pending::Approvals => self.approvals = array(result),
                        Pending::Settings => {
                            let p = &result["provider"];
                            self.protocol = p["protocol"].as_str().unwrap_or("responses").into();
                            self.endpoint = p["baseUrl"]
                                .as_str()
                                .unwrap_or("http://localhost:10100/v1")
                                .into();
                            self.model = p["model"].as_str().unwrap_or("gpt-6-luna").into();
                            self.key_path = p["apiKeyPath"]
                                .as_str()
                                .or_else(|| p["apiKeyFile"].as_str())
                                .unwrap_or("")
                                .into();
                            self.advanced_settings =
                                serde_json::to_string_pretty(&result).unwrap_or_default();
                            self.settings = result;
                        }
                        Pending::CreateProject => {
                            let id = text(&result, "id").to_owned();
                            self.projects.push(result);
                            self.prefs.selected_project = id.clone();
                            self.request(
                                "sessions.create",
                                json!({"projectId":id,"title":"새 작업"}),
                                Pending::CreateSession,
                            );
                            self.create_open = false;
                        }
                        Pending::CreateSession => {
                            let id = text(&result, "id").to_owned();
                            self.sessions.push(result);
                            self.select_session(id);
                            if self.smoke_scenario.is_some() && self.smoke_phase == 1 {
                                self.smoke_phase = 2;
                            }
                        }
                        Pending::Files(session) => {
                            if session == self.prefs.selected_session {
                                self.files = array(result);
                            }
                        }
                        Pending::Read(session) => {
                            let path = text(&result, "path").to_owned();
                            let content = text(&result, "content").to_owned();
                            let version = text(&result, "version").to_owned();
                            if let Some(index) = self
                                .buffers
                                .iter()
                                .position(|b| b.path == path && b.session == session)
                            {
                                self.buffers[index].reload(content, version);
                                self.active_buffer = index;
                            } else {
                                self.buffers.push(Buffer {
                                    path,
                                    session,
                                    text: content.clone(),
                                    saved: content,
                                    version,
                                    conflict: None,
                                });
                                self.active_buffer = self.buffers.len() - 1;
                            }
                            self.prefs.edit_mode = true;
                        }
                        Pending::Save { index, submitted } => {
                            if let Some(buffer) = self.buffers.get_mut(index) {
                                buffer.accept_saved(&submitted, text(&result, "version").into());
                            }
                            self.status = "저장 완료".into();
                        }
                        Pending::Command => {
                            self.terminal.push_str(
                                &serde_json::to_string_pretty(&result).unwrap_or_default(),
                            );
                            self.terminal.push('\n');
                        }
                        Pending::Memory => self.memories = array(result),
                        Pending::Generic(label) => {
                            self.status = format!("{label}: 완료");
                            self.refresh();
                        }
                        Pending::Silent => {}
                        Pending::LspStart => {
                            self.lsp_ready = true;
                            self.lsp_open.clear();
                            self.status = "언어 서버 연결됨".into();
                        }
                        Pending::LspCatalog => self.lsp_catalog = array(result),
                        Pending::Git => {
                            self.git_patch = text(&result, "stdout").into();
                            self.git_output =
                                serde_json::to_string_pretty(&result).unwrap_or_default();
                        }
                        Pending::Inspector => {
                            self.rpc_output =
                                serde_json::to_string_pretty(&result).unwrap_or_default()
                        }
                        Pending::Preview => {
                            let (tx, rx) = std::sync::mpsc::channel();
                            self.image_rx = Some(rx);
                            self.preview_note = "이미지 해석 중…".into();
                            self.preview_open = true;
                            self.preview_image = None;
                            std::thread::spawn(move || {
                                use base64::Engine;
                                let output = (|| {
                                    let bytes = base64::engine::general_purpose::STANDARD
                                        .decode(text(&result, "base64"))
                                        .map_err(|e| e.to_string())?;
                                    let mut reader =
                                        image::ImageReader::new(std::io::Cursor::new(bytes))
                                            .with_guessed_format()
                                            .map_err(|e| e.to_string())?;
                                    let mut limits = image::Limits::default();
                                    limits.max_image_width = Some(8192);
                                    limits.max_image_height = Some(8192);
                                    limits.max_alloc = Some(128 * 1024 * 1024);
                                    reader.limits(limits);
                                    let image =
                                        reader.decode().map_err(|e| e.to_string())?.into_rgba8();
                                    let size = [image.width() as usize, image.height() as usize];
                                    Ok((
                                        text(&result, "path").to_owned(),
                                        egui::ColorImage::from_rgba_unmultiplied(
                                            size,
                                            image.as_raw(),
                                        ),
                                    ))
                                })();
                                let _ = tx.send(output);
                            });
                        }
                        Pending::RunStart(_) => {
                            self.status = "요청 접수됨".into();
                            self.refresh();
                        }
                        Pending::LspResult(kind, snapshot, cursor) => {
                            self.lsp_result = result;
                            self.lsp_kind = kind;
                            self.lsp_snapshot = snapshot;
                            self.lsp_cursor = cursor;
                            self.bottom_tab = 3;
                            self.bottom_open = true;
                        }
                    }
                }
            }
        }
    }
    fn save_buffer(&mut self) {
        if let Some(buffer) = self.buffers.get(self.active_buffer)
            && buffer.session == self.prefs.selected_session
        {
            self.request("files.write",json!({"sessionId":buffer.session,"path":buffer.path,"content":buffer.text,"baseVersion":buffer.version}),Pending::Save{index:self.active_buffer,submitted:buffer.text.clone()});
        }
    }
    fn send_message(&mut self) {
        if self.composer.trim().is_empty() || self.prefs.selected_session.is_empty() {
            return;
        }
        let input = std::mem::take(&mut self.composer);
        self.request(
            "runs.start",
            json!({"sessionId":self.prefs.selected_session,"input":input}),
            Pending::RunStart(input.clone()),
        );
    }
    fn editor(&mut self, ui: &mut egui::Ui) {
        if !self
            .buffers
            .get(self.active_buffer)
            .is_some_and(|b| b.session == self.prefs.selected_session)
            && let Some(index) = self
                .buffers
                .iter()
                .position(|b| b.session == self.prefs.selected_session)
        {
            self.active_buffer = index;
        }
        if !self
            .buffers
            .get(self.active_buffer)
            .is_some_and(|b| b.session == self.prefs.selected_session)
        {
            ui.heading("편집기");
            ui.label("왼쪽 파일 목록에서 파일을 여세요. 편집 버퍼는 작업 전환 중에도 보존됩니다.");
            return;
        }
        ui.horizontal_wrapped(|ui| {
            for (index, buffer) in self
                .buffers
                .iter()
                .enumerate()
                .filter(|(_, b)| b.session == self.prefs.selected_session)
            {
                let title = format!(
                    "{}{}",
                    PathBuf::from(&buffer.path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy(),
                    if buffer.dirty() { " •" } else { "" }
                );
                if ui
                    .selectable_label(index == self.active_buffer, title)
                    .clicked()
                {
                    self.active_buffer = index;
                }
            }
        });
        ui.horizontal_wrapped(|ui| {
            if ui.button("저장  Ctrl+S").clicked() {
                self.save_buffer();
            }
            ui.checkbox(&mut self.prefs.split_editor, "원본과 분할");
            ui.menu_button("코드 탐색", |ui| {
                for (method, label) in [
                    ("completion", "자동완성"),
                    ("definition", "정의"),
                    ("references", "참조"),
                    ("diagnostics", "진단"),
                ] {
                    if ui
                        .add_enabled(self.lsp_ready, egui::Button::new(label))
                        .clicked()
                    {
                        self.lsp_action(method);
                        ui.close();
                    }
                }
                if !self.lsp_ready && ui.button("언어 서버 연결").clicked() {
                    self.settings_open = true;
                    ui.close();
                }
            });
        });
        let buffer = &mut self.buffers[self.active_buffer];
        ui.label(RichText::new(&buffer.path).small());
        if let Some(conflict) = &buffer.conflict {
            ui.colored_label(Color32::from_rgb(190, 60, 45), conflict);
        }
        let extension = PathBuf::from(&buffer.path)
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let edit_id = format!("buffer:{}:{}", buffer.session, buffer.path);
        let go = if self
            .goto
            .as_ref()
            .is_some_and(|(path, _, _)| path == &buffer.path)
        {
            self.goto.take().and_then(|(_, line, column)| {
                state::lsp_byte_offset(&buffer.text, line, column)
                    .map(|byte| buffer.text[..byte].chars().count())
            })
        } else {
            None
        };
        if self.prefs.split_editor {
            ui.columns(2, |columns| {
                columns[0].label("저장된 원본");
                egui::ScrollArea::both()
                    .id_salt("original")
                    .show(&mut columns[0], |ui| {
                        ui.add(
                            egui::Label::new(RichText::new(&buffer.saved).monospace())
                                .selectable(true),
                        );
                    });
                columns[1].label("편집 내용");
                if let Some(cursor) =
                    code_edit(&mut columns[1], &mut buffer.text, &extension, &edit_id, go)
                {
                    self.editor_cursor = cursor;
                }
            });
        } else if let Some(cursor) = code_edit(ui, &mut buffer.text, &extension, &edit_id, go) {
            self.editor_cursor = cursor;
        }
    }
    fn bottom(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            ui.selectable_value(&mut self.bottom_tab, 0, "명령 실행");
            ui.selectable_value(&mut self.bottom_tab, 1, "승인");
            ui.selectable_value(&mut self.bottom_tab, 2, "실행 작업");
            ui.selectable_value(&mut self.bottom_tab, 3, "언어 분석");
            ui.selectable_value(&mut self.bottom_tab, 4, "터미널");
            ui.selectable_value(&mut self.bottom_tab, 5, "Git diff");
            ui.selectable_value(&mut self.bottom_tab, 6, "도구 연결");
            ui.label(RichText::new("현재 세션 실행 대상").small());
        });
        match self.bottom_tab {
            0 => {
                ui.horizontal(|ui| {
                    ui.add(
                        egui::TextEdit::singleline(&mut self.command)
                            .desired_width((ui.available_width() - 75.0).max(120.0))
                            .hint_text("명령 입력 (대화형 PTY 아님)"),
                    );
                    if ui
                        .add_enabled(
                            !self.prefs.selected_session.is_empty(),
                            egui::Button::new("실행"),
                        )
                        .clicked()
                        && !self.command.trim().is_empty()
                    {
                        let command = std::mem::take(&mut self.command);
                        self.terminal.push_str(&format!("\n$ {command}\n"));
                        self.request(
                            "command.run",
                            json!({"sessionId":self.prefs.selected_session,"command":command}),
                            Pending::Command,
                        );
                    }
                });
                egui::ScrollArea::both()
                    .id_salt("terminal")
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        ui.add(
                            egui::Label::new(RichText::new(&self.terminal).monospace())
                                .selectable(true),
                        );
                    });
            }
            1 => {
                egui::ScrollArea::vertical()
                    .id_salt("approvals")
                    .show(ui, |ui| {
                        if self.approvals.is_empty() {
                            ui.label("대기 중인 승인이 없습니다.");
                        }
                        let approvals = self.approvals.clone();
                        for approval in approvals {
                            ui.label(serde_json::to_string_pretty(&approval).unwrap_or_default());
                            ui.horizontal(|ui| {
                                for (approved, label) in [(true, "이번 실행 허용"), (false, "거절")]
                                {
                                    if ui.button(label).clicked() {
                                        self.request(
                                            "approvals.resolve",
                                            json!({"id":approval["id"],"approved":approved}),
                                            Pending::Generic("승인 응답".into()),
                                        );
                                    }
                                }
                            });
                            ui.separator();
                        }
                    })
                    .inner
            }
            2 => {
                egui::ScrollArea::vertical()
                    .id_salt("runs")
                    .show(ui, |ui| {
                        for run in &self.runs {
                            ui.label(format!(
                                "{} · {} · generation {}",
                                text(run, "id"),
                                text(run, "status"),
                                run["generation"]
                            ));
                        }
                    })
                    .inner
            }
            3 => self.lsp_results(ui),
            4 => self.pty_panel(ui),
            5 => self.git_panel(ui),
            _ => self.rpc_panel(ui),
        }
    }
    fn pty_panel(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            if ui.button("현재 세션 터미널 열기").clicked()
                && let Some(session) = self
                    .sessions
                    .iter()
                    .find(|s| text(s, "id") == self.prefs.selected_session)
            {
                match terminal::Terminal::start(
                    &self.prefs.selected_session,
                    text(session, "cwd"),
                    &session["target"],
                    ui.ctx().clone(),
                ) {
                    Ok(pty) => self.pty = Some(pty),
                    Err(error) => self.status = error,
                }
            }
            if let Some(pty) = &mut self.pty {
                ui.label(format!("세션: {}", pty.session));
                if ui.button("Ctrl+C").clicked() {
                    let _ = pty.write(&[3]);
                }
            }
            if ui.button("닫기").clicked() {
                self.pty = None;
            }
        });
        if let Some(pty) = &mut self.pty {
            pty.resize(
                ((ui.available_height() - 42.0) / 18.0) as u16,
                (ui.available_width() / 8.0) as u16,
            );
            let contents = pty.contents();
            egui::ScrollArea::both()
                .max_height((ui.available_height() - 42.0).max(50.0))
                .id_salt("pty-screen")
                .stick_to_bottom(true)
                .show(ui, |ui| {
                    ui.add(egui::Label::new(RichText::new(contents).monospace()).selectable(true));
                });
            ui.horizontal(|ui| {
                let response = ui.add(
                    egui::TextEdit::singleline(&mut self.pty_input)
                        .desired_width((ui.available_width() - 230.0).max(100.0))
                        .hint_text("터미널 입력"),
                );
                let enter = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if ui.button("입력").clicked() || enter {
                    let line = std::mem::take(&mut self.pty_input) + "\r";
                    if let Err(error) = pty.write(line.as_bytes()) {
                        self.status = error;
                    }
                    response.request_focus();
                }
                for (label, bytes) in [
                    ("↑", b"\x1b[A".as_slice()),
                    ("↓", b"\x1b[B".as_slice()),
                    ("Tab", b"\t".as_slice()),
                    ("Esc", b"\x1b".as_slice()),
                ] {
                    if ui.button(label).clicked() {
                        let _ = pty.write(bytes);
                    }
                }
            });
        } else {
            ui.label("로컬 셸 또는 기존 SSH config를 사용하는 대화형 PTY입니다. 이 터미널은 GUI 종료 시 닫힙니다.");
        }
    }
    fn git_panel(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui|{
            for (method,label) in [("git.diff","변경 조회"),("git.status","Git 상태")]{if ui.button(label).clicked(){self.request(method,json!({"sessionId":self.prefs.selected_session}),Pending::Git);}}
            if ui.button("선택한 patch 스테이징").clicked()&&!self.git_patch.trim().is_empty(){self.request("git.apply",json!({"sessionId":self.prefs.selected_session,"patch":self.git_patch,"cached":true}),Pending::Generic("Patch 스테이징".into()));}
        });
        ui.label("포함할 hunk만 남겨 unified patch를 편집할 수 있습니다. 적용 전에 Git이 문맥을 검증합니다.");
        egui::ScrollArea::both()
            .id_salt("git-patch")
            .show(ui, |ui| {
                ui.add(
                    egui::TextEdit::multiline(&mut self.git_patch)
                        .code_editor()
                        .desired_width(f32::INFINITY)
                        .desired_rows(10),
                );
            });
    }
    fn rpc_panel(&mut self, ui: &mut egui::Ui) {
        ui.label("고급 도구 연결 · 실제 RPC 실행 (설정과 작업이 변경될 수 있습니다)");
        ui.horizontal(|ui| {
            ui.text_edit_singleline(&mut self.rpc_method);
            if ui.button("실행").clicked() {
                match serde_json::from_str::<Value>(&self.rpc_params) {
                    Ok(params) => {
                        self.request(&self.rpc_method.clone(), params, Pending::Inspector)
                    }
                    Err(error) => self.status = error.to_string(),
                }
            }
        });
        ui.columns(2, |columns| {
            columns[0].label("요청 인자 JSON");
            columns[0].add(
                egui::TextEdit::multiline(&mut self.rpc_params)
                    .code_editor()
                    .desired_rows(4)
                    .desired_width(f32::INFINITY),
            );
            egui::ScrollArea::both()
                .id_salt("rpc-result")
                .show(&mut columns[1], |ui| {
                    ui.add(
                        egui::Label::new(RichText::new(&self.rpc_output).monospace())
                            .selectable(true),
                    );
                });
        });
    }
    fn lsp_action(&mut self, action: &str) {
        let Some(buffer) = self.buffers.get(self.active_buffer) else {
            return;
        };
        if !self.lsp_ready || buffer.session != self.lsp_session {
            self.status = "이 파일의 세션에서 언어 서버를 연결하세요.".into();
            return;
        }
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| text(s, "id") == buffer.session)
        else {
            return;
        };
        let remote = text(&session["target"], "kind") == "ssh";
        let path = if remote {
            PathBuf::from(if buffer.path.starts_with('/') {
                buffer.path.clone()
            } else {
                format!(
                    "{}/{}",
                    text(session, "cwd").trim_end_matches('/'),
                    buffer.path
                )
            })
        } else {
            PathBuf::from(text(session, "cwd")).join(&buffer.path)
        };
        let uri_result = if remote {
            let mut uri = url::Url::parse("file:///").unwrap();
            uri.set_path(&path.to_string_lossy().replace('\\', "/"));
            Ok(uri)
        } else {
            url::Url::from_file_path(&path)
        };
        let Ok(uri) = uri_result else {
            self.status = "파일 URI를 만들 수 없습니다.".into();
            return;
        };
        let uri = uri.to_string();
        let source = buffer.text.clone();
        let position = state::lsp_position(&source, self.editor_cursor);
        let language = match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
            "py" => "python",
            "cpp" | "hpp" | "cc" | "h" => "cpp",
            "c" => "c",
            "rs" => "rust",
            "kt" | "kts" => "kotlin",
            "java" => "java",
            "ts" | "tsx" => "typescript",
            "js" => "javascript",
            "cmake" | "txt" => "cmake",
            "gradle" | "groovy" => "groovy",
            _ => "plaintext",
        };
        self.lsp_version += 1;
        let (method, params) = if self.lsp_open.contains_key(&uri) {
            (
                "textDocument/didChange",
                json!({"textDocument":{"uri":uri,"version":self.lsp_version},"contentChanges":[{"text":source}]}),
            )
        } else {
            (
                "textDocument/didOpen",
                json!({"textDocument":{"uri":uri,"languageId":language,"version":self.lsp_version,"text":source}}),
            )
        };
        self.lsp_open.insert(uri.clone(), self.lsp_version);
        self.request(
            "lsp.notify",
            json!({"id":"desktop","method":method,"params":params}),
            Pending::Silent,
        );
        if action == "diagnostics" {
            self.request(
                "lsp.diagnostics",
                json!({"id":"desktop"}),
                Pending::LspResult(action.into(), source, self.editor_cursor),
            );
        } else {
            self.request("lsp.request",json!({"id":"desktop","method":format!("textDocument/{action}"),"params":{"textDocument":{"uri":uri},"position":{"line":position.0,"character":position.1},"context":{"includeDeclaration":true}}}),Pending::LspResult(action.into(),source,self.editor_cursor));
        }
    }
    fn open_location(&mut self, uri: &str, position: &Value) {
        let remote = self
            .sessions
            .iter()
            .find(|s| text(s, "id") == self.lsp_session)
            .is_some_and(|s| text(&s["target"], "kind") == "ssh");
        if let Ok(path) = url::Url::parse(uri).and_then(|url| {
            if remote {
                Ok(percent_encoding::percent_decode_str(url.path())
                    .decode_utf8_lossy()
                    .into_owned())
            } else {
                url.to_file_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|_| url::ParseError::RelativeUrlWithoutBase)
            }
        }) {
            let line = position["line"].as_u64().unwrap_or(0) as usize;
            let column = position["character"].as_u64().unwrap_or(0) as usize;
            self.goto = Some((path.clone(), line, column));
            self.request(
                "files.read",
                json!({"sessionId":self.lsp_session,"path":path}),
                Pending::Read(self.lsp_session.clone()),
            );
        }
    }
    fn lsp_results(&mut self, ui: &mut egui::Ui) {
        ui.label(format!("언어 분석 · {}", self.lsp_kind));
        let results = self.lsp_result.clone();
        egui::ScrollArea::vertical()
            .id_salt("lsp-results")
            .show(ui, |ui| {
                if self.lsp_kind == "completion" {
                    let items = results.as_array().or_else(|| results["items"].as_array());
                    if let Some(items) = items {
                        for item in items.iter().take(200) {
                            if ui.button(text(item, "label")).clicked()
                                && let Some(buffer) = self.buffers.get_mut(self.active_buffer)
                            {
                                if buffer.text == self.lsp_snapshot {
                                    match state::apply_completion(
                                        &mut buffer.text,
                                        item,
                                        self.lsp_cursor,
                                    ) {
                                        Ok(()) => {
                                            self.lsp_result = Value::Null;
                                            self.status =
                                                "완성 제안을 편집 버퍼에 적용했습니다.".into();
                                        }
                                        Err(error) => self.status = error,
                                    }
                                } else {
                                    self.status =
                                        "완성 요청 이후 파일이 변경되었습니다. 다시 요청하세요."
                                            .into();
                                }
                            }
                        }
                    }
                } else if self.lsp_kind == "diagnostics" {
                    if let Some(documents) = results.as_array() {
                        for document in documents {
                            if let Some(diagnostics) = document["diagnostics"].as_array() {
                                for diagnostic in diagnostics {
                                    let start = &diagnostic["range"]["start"];
                                    if ui
                                        .button(format!(
                                            "{}:{} {}",
                                            text(document, "uri"),
                                            start["line"].as_u64().unwrap_or(0) + 1,
                                            text(diagnostic, "message")
                                        ))
                                        .clicked()
                                    {
                                        self.open_location(text(document, "uri"), start);
                                    }
                                }
                            }
                        }
                    }
                } else {
                    let locations = results.as_array().cloned().unwrap_or_else(|| {
                        if results.is_object() {
                            vec![results]
                        } else {
                            vec![]
                        }
                    });
                    for location in locations {
                        let uri = location["uri"]
                            .as_str()
                            .or_else(|| location["targetUri"].as_str())
                            .unwrap_or("");
                        let position = location
                            .get("range")
                            .or_else(|| location.get("targetSelectionRange"))
                            .map(|range| &range["start"])
                            .unwrap_or(&Value::Null);
                        if ui
                            .button(format!(
                                "{}:{}",
                                uri,
                                position["line"].as_u64().unwrap_or(0) + 1
                            ))
                            .clicked()
                        {
                            self.open_location(uri, position);
                        }
                    }
                }
            });
    }
    fn windows(&mut self, ctx: &egui::Context) {
        if let Some(rx) = &self.image_rx
            && let Ok(result) = rx.try_recv()
        {
            self.image_rx = None;
            match result {
                Ok((path, image)) => {
                    let texture = ctx.load_texture(&path, image, egui::TextureOptions::LINEAR);
                    self.preview_image = Some((path, texture));
                    self.preview_note.clear();
                }
                Err(error) => self.preview_note = error,
            }
        }
        if self.preview_open {
            egui::Window::new("미리보기")
                .open(&mut self.preview_open)
                .default_size([680.0, 500.0])
                .show(ctx, |ui| {
                    if let Some((path, texture)) = &self.preview_image {
                        ui.label(path);
                        ui.add(egui::Image::new(texture).max_size(ui.available_size()));
                    } else {
                        ui.label(&self.preview_note);
                    }
                });
        }
        if self.new_session_open {
            let mut open = true;
            egui::Window::new("새 작업의 실행 대상").open(&mut open).default_width(540.0).show(ctx,|ui|{
                ui.label("작업 제목");ui.text_edit_singleline(&mut self.new_session_title);ui.checkbox(&mut self.remote,"SSH 대상");
                if self.remote{ui.label("SSH config Host");ui.text_edit_singleline(&mut self.new_host);ui.label("Docker 컨테이너 (선택)");ui.text_edit_singleline(&mut self.new_container);}
                ui.label("이 세션의 기준 디렉토리");ui.text_edit_singleline(&mut self.new_root);
                if ui.button("작업 만들기").clicked(){let mut target=if self.remote{json!({"kind":"ssh","host":self.new_host})}else{json!({"kind":"local"})};if self.remote&&!self.new_container.is_empty(){target["container"]=json!(self.new_container);}self.request("sessions.create",json!({"projectId":self.prefs.selected_project,"title":self.new_session_title,"cwd":self.new_root,"target":target}),Pending::CreateSession);self.new_session_open=false;}
            });
            if !open {
                self.new_session_open = false;
            }
        }
        if self.create_open {
            let mut open = true;
            egui::Window::new("프로젝트 등록")
                .open(&mut open)
                .default_width(540.0)
                .show(ctx, |ui| {
                    ui.label("이름");
                    ui.text_edit_singleline(&mut self.new_project);
                    ui.checkbox(&mut self.remote, "SSH 실행 대상");
                    if self.remote {
                        ui.label("기존 SSH config의 Host 별칭");
                        ui.text_edit_singleline(&mut self.new_host);
                        ui.label("Docker 컨테이너 이름 (선택)");
                        ui.text_edit_singleline(&mut self.new_container);
                    }
                    ui.label("기준 디렉토리 (대상 시스템의 절대 경로)");
                    ui.text_edit_singleline(&mut self.new_root);
                    if ui.button("프로젝트와 첫 작업 만들기").clicked() {
                        let target = if self.remote {
                            let mut target = json!({"kind":"ssh","host":self.new_host});
                            if !self.new_container.is_empty() {
                                target["container"] = json!(self.new_container);
                            }
                            target
                        } else {
                            json!({"kind":"local"})
                        };
                        self.request(
                            "projects.create",
                            json!({"name":self.new_project,"root":self.new_root,"target":target}),
                            Pending::CreateProject,
                        );
                    }
                });
            if !open {
                self.create_open = false;
            }
        }
        if self.settings_open {
            let mut open = true;
            egui::Window::new("설정").open(&mut open).default_width(600.0).vscroll(true).show(ctx,|ui|{
                ui.heading("화면 테마");
                ui.horizontal(|ui| {
                    if ui.selectable_label(!self.prefs.dark && !self.prefs.solarized,"Codex Light").clicked(){self.prefs.dark=false;self.prefs.solarized=false;}
                    if ui.selectable_label(self.prefs.dark,"Dark").clicked(){self.prefs.dark=true;self.prefs.solarized=false;}
                    if ui.selectable_label(!self.prefs.dark && self.prefs.solarized,"Solarized Light").clicked(){self.prefs.dark=false;self.prefs.solarized=true;}
                });ui.separator();ui.heading("모델 연결");
                egui::ComboBox::from_label("프로토콜").selected_text(&self.protocol).show_ui(ui,|ui|{for protocol in ["responses","chat-completions","anthropic"]{ui.selectable_value(&mut self.protocol,protocol.into(),protocol);}});
                ui.label("API base URL");ui.text_edit_singleline(&mut self.endpoint);ui.label("모델");ui.text_edit_singleline(&mut self.model);
                ui.label("API key 파일 경로 (선택, 비밀값은 화면에 표시하지 않음)");ui.text_edit_singleline(&mut self.key_path);
                if ui.button("연결 설정 저장").clicked(){let mut settings=self.settings.clone();settings["provider"]=json!({"protocol":self.protocol,"baseUrl":self.endpoint,"model":self.model});if !self.key_path.is_empty(){settings["provider"]["apiKeyPath"]=json!(self.key_path);}self.settings=settings.clone();self.request("settings.update",settings,Pending::Generic("설정 저장".into()));}
                ui.collapsing("전체 설정 (JSON)",|ui|{ui.add(egui::TextEdit::multiline(&mut self.advanced_settings).code_editor().desired_rows(8).desired_width(f32::INFINITY));if ui.button("전체 설정 검증·저장").clicked(){match serde_json::from_str::<Value>(&self.advanced_settings){Ok(value)=>{self.settings=value.clone();self.request("settings.update",value,Pending::Generic("전체 설정".into()));},Err(error)=>self.status=error.to_string()}}});
                ui.separator();ui.heading("언어 서버 · 현재 세션");
                ui.label("서버는 별도 설치·관리합니다. 로컬 또는 SSH 대상에서 지정한 명령을 실행합니다.");
                egui::ComboBox::from_label("서버 preset").selected_text(&self.lsp_command).show_ui(ui,|ui|{for server in &self.lsp_catalog{if ui.selectable_label(false,text(server,"id")).clicked(){self.lsp_command=text(server,"command").into();self.lsp_args=server["args"].to_string();}}});
                ui.text_edit_singleline(&mut self.lsp_command);ui.label("인자 JSON 배열");ui.text_edit_singleline(&mut self.lsp_args);
                if ui.button("언어 서버 시작").clicked(){
                    if let Some(session)=self.sessions.iter().find(|s|text(s,"id")==self.prefs.selected_session){
                        match serde_json::from_str::<Vec<String>>(&self.lsp_args){Ok(args)=>{let cwd=text(session,"cwd").to_owned();let target=session["target"].clone();self.lsp_session=self.prefs.selected_session.clone();self.lsp_ready=false;self.request("lsp.start",json!({"id":"desktop","command":self.lsp_command,"args":args,"cwd":cwd,"target":target}),Pending::LspStart);},Err(error)=>self.status=error.to_string()}
                    }else{self.status="먼저 작업을 선택하세요.".into();}
                }
                ui.separator();ui.heading("Core hot reload");ui.label("후보 JS 파일의 절대 경로 (비우면 기본 core 재로드)");ui.text_edit_singleline(&mut self.core_path);ui.checkbox(&mut self.core_migrate,"실행 중 작업도 안전 지점에서 전환");
                if ui.button("후보 검증 후 교체").clicked(){let mut params=json!({"migrateActive":self.core_migrate,"timeoutMs":120000});if !self.core_path.is_empty(){params["filePath"]=json!(self.core_path);}self.request("core.reload",params,Pending::Generic("Core 교체".into()));}
                ui.label("진행 중 모델 호출·도구 작업은 먼저 마무리합니다.");
                ui.separator();ui.label("사내 연동은 설정·실제 프로그램 등록이 필요합니다. 모의 결과는 실제 업무 수행으로 표시하지 않습니다.");
            });
            if !open {
                self.settings_open = false;
            }
        }
        if self.memory_open {
            let mut open = true;
            egui::Window::new("프로젝트 기억").open(&mut open).default_width(650.0).show(ctx,|ui|{
                ui.horizontal(|ui|{ui.text_edit_singleline(&mut self.memory_query);if ui.button("검색").clicked(){self.request("memory.search",json!({"projectId":self.prefs.selected_project,"query":self.memory_query}),Pending::Memory);}});
                egui::ScrollArea::vertical().max_height(260.0).show(ui,|ui|{for memory in &self.memories{ui.label(text(memory,"content"));ui.label(RichText::new(format!("{} · {}",text(memory,"kind"),text(memory,"source"))).small());ui.separator();}});
                ui.add(egui::TextEdit::multiline(&mut self.memory_text).desired_rows(3).desired_width(f32::INFINITY).hint_text("확정된 프로젝트 지식"));
                if ui.button("기억 추가").clicked()&&!self.memory_text.trim().is_empty(){let content=std::mem::take(&mut self.memory_text);self.request("memory.upsert",json!({"projectId":self.prefs.selected_project,"content":content,"kind":"fact","source":"사용자 직접 입력"}),Pending::Generic("기억 저장".into()));self.request("memory.list",json!({"projectId":self.prefs.selected_project}),Pending::Memory);}
            });
            if !open {
                self.memory_open = false;
            }
        }
    }
}

fn code_edit(
    ui: &mut egui::Ui,
    text: &mut String,
    language: &str,
    id: &str,
    go: Option<usize>,
) -> Option<usize> {
    let theme = egui_extras::syntax_highlighting::CodeTheme::from_memory(ui.ctx(), ui.style());
    let mut layouter = |ui: &egui::Ui, buffer: &dyn egui::TextBuffer, wrap_width: f32| {
        let mut job = egui_extras::syntax_highlighting::highlight(
            ui.ctx(),
            ui.style(),
            &theme,
            buffer.as_str(),
            language,
        );
        job.wrap.max_width = wrap_width;
        ui.fonts_mut(|fonts| fonts.layout_job(job))
    };
    egui::ScrollArea::both()
        .id_salt(id)
        .show(ui, |ui| {
            let widget_id = egui::Id::new(id);
            if let Some(cursor) = go {
                let mut state = egui::TextEdit::load_state(ui.ctx(), widget_id).unwrap_or_default();
                state
                    .cursor
                    .set_char_range(Some(egui::text::CCursorRange::one(
                        egui::text::CCursor::new(cursor),
                    )));
                state.store(ui.ctx(), widget_id);
                ui.memory_mut(|m| m.request_focus(widget_id));
            }
            let output = egui::TextEdit::multiline(text)
                .id(widget_id)
                .font(egui::TextStyle::Monospace)
                .code_editor()
                .desired_width(f32::INFINITY)
                .desired_rows(30)
                .layouter(&mut layouter)
                .show(ui);
            output.cursor_range.map(|range| range.primary.index)
        })
        .inner
}

impl eframe::App for HarnessApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain();
        if let Some(path) = self.smoke_scenario.clone() {
            if self.connected && self.smoke_phase == 0 {
                self.smoke_phase = 1;
                self.request("projects.create",json!({"name":"Desktop validation","root":path.to_string_lossy(),"target":{"kind":"local"}}),Pending::CreateProject);
            }
            if self.smoke_phase == 2 {
                self.smoke_phase = 3;
                self.request(
                    "files.read",
                    json!({"sessionId":self.prefs.selected_session,"path":"smoke.py"}),
                    Pending::Read(self.prefs.selected_session.clone()),
                );
            }
            if self.smoke_phase == 3
                && self
                    .buffers
                    .iter()
                    .any(|b| b.session == self.prefs.selected_session)
            {
                self.smoke_phase = 4;
                self.buffers[self.active_buffer]
                    .text
                    .push_str("\n# desktop save verified\n");
                self.save_buffer();
                self.composer="한국어로 한 문장만 답해줘: 데스크톱 연결 테스트가 완료되었습니다. 도구를 실행하지 마세요.".into();
                self.send_message();
                self.left_tab = 1;
                self.prefs.edit_mode = true;
            }
            if self.smoke_phase == 4 && self.messages.iter().any(|m| text(m, "role") == "assistant")
            {
                self.smoke_phase = 5;
                self.smoke_completed = Some(Instant::now());
                if let Some(path) = self.smoke_preview.clone() {
                    self.request(
                        "files.preview",
                        json!({"sessionId":self.prefs.selected_session,"path":path}),
                        Pending::Preview,
                    );
                }
            }
        }
        self.visuals(ctx);
        if self.smoke_report.is_some() && self.smoke_chat {
            self.prefs.edit_mode = false;
            self.left_tab = 0;
        }
        if self.connected
            && self.last_poll.elapsed() > Duration::from_secs(2)
            && self.pending.len() < 8
        {
            self.refresh();
            self.last_poll = Instant::now();
        }
        if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::S)) {
            self.save_buffer();
        }
        if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter)) {
            self.send_message();
        }
        if ctx.input(|i| i.modifiers.ctrl && i.key_pressed(egui::Key::Space)) {
            self.lsp_action("completion");
        }
        let palette = appearance::palette(self.prefs.dark, self.prefs.solarized);
        if !self.prefs.sidebar_collapsed {
            egui::SidePanel::left("navigation-v2")
                .default_width(248.0)
                .width_range(210.0..=320.0)
                .resizable(true)
                .frame(
                    egui::Frame::new()
                        .fill(palette.sidebar)
                        .inner_margin(egui::Margin::symmetric(12, 14)),
                )
                .show(ctx, |ui| self.sidebar(ui));
        }
        egui::TopBottomPanel::top("task-header-v2")
            .exact_height(58.0)
            .frame(
                egui::Frame::new()
                    .fill(palette.canvas)
                    .inner_margin(egui::Margin::symmetric(22, 10)),
            )
            .show(ctx, |ui| self.header(ui));
        egui::TopBottomPanel::bottom("workspace-status")
            .exact_height(24.0)
            .frame(
                egui::Frame::new()
                    .fill(palette.canvas)
                    .inner_margin(egui::Margin::symmetric(20, 3)),
            )
            .show(ctx, |ui| {
                ui.add(
                    egui::Label::new(RichText::new(&self.status).small().color(palette.muted))
                        .truncate(),
                )
                .on_hover_text(&self.status);
            });
        if self.bottom_open {
            let max_height = (ctx.available_rect().height() - 300.0).clamp(110.0, 400.0);
            egui::TopBottomPanel::bottom("execution")
                .resizable(true)
                .default_height(230.0_f32.min(max_height))
                .height_range(110.0..=max_height)
                .frame(
                    egui::Frame::new()
                        .fill(palette.canvas)
                        .stroke(egui::Stroke::new(1.0_f32, palette.border))
                        .inner_margin(12),
                )
                .show(ctx, |ui| self.bottom(ui));
        }
        let wide = ctx.available_rect().width() >= 880.0;
        if self.prefs.edit_mode {
            if wide {
                egui::SidePanel::right("chat-pane-v2")
                    .resizable(true)
                    .default_width(380.0)
                    .width_range(320.0..=550.0)
                    .frame(
                        egui::Frame::new()
                            .fill(palette.canvas)
                            .stroke(egui::Stroke::new(1.0_f32, palette.border))
                            .inner_margin(8),
                    )
                    .show(ctx, |ui| self.chat(ui));
            }
            egui::CentralPanel::default()
                .frame(egui::Frame::new().fill(palette.canvas).inner_margin(16))
                .show(ctx, |ui| self.editor(ui));
        } else {
            if self.prefs.show_preview
                && self
                    .buffers
                    .iter()
                    .any(|b| b.session == self.prefs.selected_session)
                && wide
            {
                egui::SidePanel::right("preview-pane-v2")
                    .resizable(true)
                    .default_width(420.0)
                    .frame(
                        egui::Frame::new()
                            .fill(palette.canvas)
                            .stroke(egui::Stroke::new(1.0_f32, palette.border))
                            .inner_margin(12),
                    )
                    .show(ctx, |ui| self.editor(ui));
            }
            egui::CentralPanel::default()
                .frame(
                    egui::Frame::new()
                        .fill(palette.canvas)
                        .inner_margin(egui::Margin::symmetric(8, 12)),
                )
                .show(ctx, |ui| self.chat(ui));
        }
        self.windows(ctx);
        ctx.request_repaint_after(Duration::from_millis(250));
        if self.smoke_report.is_some()
            && !self.screenshot_requested
            && self.started.elapsed() > Duration::from_secs(2)
            && (self.smoke_scenario.is_none() || self.smoke_phase >= 5)
            && (self.smoke_preview.is_none() || self.preview_image.is_some())
        {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::default()));
            self.screenshot_requested = true;
        }
        if let Some(path) = &self.smoke_report {
            for event in ctx.input(|i| i.events.clone()) {
                if let egui::Event::Screenshot { image, .. } = event
                    && let Ok(file) = std::fs::File::create(path.with_extension("png"))
                {
                    let mut encoder =
                        png::Encoder::new(file, image.size[0] as u32, image.size[1] as u32);
                    encoder.set_color(png::ColorType::Rgba);
                    encoder.set_depth(png::BitDepth::Eight);
                    if let Ok(mut writer) = encoder.write_header() {
                        let data: Vec<u8> =
                            image.pixels.iter().flat_map(|p| p.to_array()).collect();
                        let _ = writer.write_image_data(&data);
                    }
                }
            }
        }
        if let Some(path) = &self.smoke_report
            && ((self.smoke_scenario.is_none() && self.started.elapsed() > Duration::from_secs(4))
                || self
                    .smoke_completed
                    .is_some_and(|time| time.elapsed() > Duration::from_secs(2))
                || self.started.elapsed() > Duration::from_secs(90))
        {
            let _=std::fs::write(path,json!({"nativeWindowRendered":true,"backendConnected":self.connected,"projects":self.projects.len(),"status":self.status,"scenarioPhase":self.smoke_phase,"assistantMessages":self.messages.iter().filter(|m|text(m,"role")=="assistant").count(),"savedFiles":self.buffers.iter().filter(|b|!b.dirty()).count(),"imagePreview":self.preview_image.is_some()}).to_string());
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }
    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        if self.smoke_report.is_some() {
            return;
        }
        self.prefs
            .project_modes
            .insert(self.prefs.selected_project.clone(), self.prefs.edit_mode);
        eframe::set_value(storage, "preferences", &self.prefs);
        eframe::set_value(storage, "buffers", &self.buffers);
    }
}
