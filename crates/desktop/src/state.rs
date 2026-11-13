use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub edit_mode: bool,
    pub dark: bool,
    pub solarized: bool,
    pub sidebar_collapsed: bool,
    pub show_preview: bool,
    pub split_editor: bool,
    pub project_modes: BTreeMap<String, bool>,
    pub selected_project: String,
    pub selected_session: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Buffer {
    pub path: String,
    pub session: String,
    pub text: String,
    pub saved: String,
    pub version: String,
    pub conflict: Option<String>,
    #[serde(default)]
    pub external: Option<(String, String)>,
}

pub fn lsp_position(text: &str, char_index: usize) -> (usize, usize) {
    let mut line = 0;
    let mut character = 0;
    for ch in text.chars().take(char_index) {
        if ch == '\n' {
            line += 1;
            character = 0;
        } else {
            character += ch.len_utf16();
        }
    }
    (line, character)
}
pub fn lsp_byte_offset(text: &str, line: usize, character: usize) -> Option<usize> {
    let mut current_line = 0;
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if current_line == line && units == character {
            return Some(byte);
        }
        if ch == '\n' {
            if current_line == line {
                return None;
            }
            current_line += 1;
            units = 0;
        } else if current_line == line {
            units += ch.len_utf16();
            if units > character {
                return None;
            }
        }
    }
    (current_line == line && units == character).then_some(text.len())
}

pub fn apply_completion(
    text: &mut String,
    item: &serde_json::Value,
    char_index: usize,
) -> Result<(), String> {
    if item["insertTextFormat"].as_u64() == Some(2) {
        return Err("Snippet completion is not supported by this client".into());
    }
    if let Some(edit) = item.get("textEdit") {
        let range = edit
            .get("range")
            .or_else(|| edit.get("replace"))
            .ok_or("Missing completion range")?;
        let start = lsp_byte_offset(
            text,
            range["start"]["line"].as_u64().ok_or("Invalid line")? as usize,
            range["start"]["character"]
                .as_u64()
                .ok_or("Invalid character")? as usize,
        )
        .ok_or("Invalid completion start")?;
        let end = lsp_byte_offset(
            text,
            range["end"]["line"].as_u64().ok_or("Invalid line")? as usize,
            range["end"]["character"]
                .as_u64()
                .ok_or("Invalid character")? as usize,
        )
        .ok_or("Invalid completion end")?;
        if start > end {
            return Err("Invalid completion range".into());
        }
        text.replace_range(
            start..end,
            edit["newText"].as_str().ok_or("Missing completion text")?,
        );
    } else {
        let end = text
            .char_indices()
            .nth(char_index)
            .map(|(i, _)| i)
            .unwrap_or(text.len());
        let start = text[..end]
            .char_indices()
            .rev()
            .find(|(_, ch)| !ch.is_alphanumeric() && *ch != '_')
            .map(|(i, ch)| i + ch.len_utf8())
            .unwrap_or(0);
        text.replace_range(
            start..end,
            item["insertText"]
                .as_str()
                .or_else(|| item["label"].as_str())
                .ok_or("Missing completion label")?,
        );
    }
    Ok(())
}
impl Buffer {
    pub fn dirty(&self) -> bool {
        self.text != self.saved
    }
    pub fn accept_saved(&mut self, submitted: &str, version: String) {
        // A response may arrive after more typing; keep that new text unsaved.
        self.saved = submitted.to_owned();
        self.version = version;
        self.conflict = None;
        self.external = None;
    }
    pub fn reload(&mut self, text: String, version: String) -> bool {
        if version == self.version {
            return true;
        }
        if self.dirty() {
            self.conflict = Some("외부 변경 감지: 편집 내용이 보존되었습니다.".into());
            self.external = Some((text, version));
            return false;
        }
        self.text = text.clone();
        self.saved = text;
        self.version = version;
        self.conflict = None;
        self.external = None;
        true
    }
    pub fn resolve_external(&mut self, use_disk: bool) {
        if let Some((text, version)) = self.external.take() {
            if use_disk {
                self.text = text.clone();
            }
            self.saved = text;
            self.version = version;
            self.conflict = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn buffer() -> Buffer {
        Buffer {
            path: "a.py".into(),
            session: "s".into(),
            text: "before".into(),
            saved: "before".into(),
            version: "v1".into(),
            conflict: None,
            external: None,
        }
    }
    #[test]
    fn edit_while_save_in_flight_stays_dirty() {
        let mut b = buffer();
        b.text = "after".into();
        let submitted = b.text.clone();
        b.text.push('!');
        b.accept_saved(&submitted, "v2".into());
        assert!(b.dirty());
        assert_eq!(b.text, "after!");
        assert_eq!(b.saved, "after");
    }
    #[test]
    fn reload_never_overwrites_unsaved_changes() {
        let mut b = buffer();
        b.text = "user".into();
        assert!(!b.reload("agent".into(), "v2".into()));
        assert_eq!(b.text, "user");
        assert_eq!(b.version, "v1");
    }
    #[test]
    fn clean_reload_updates_version() {
        let mut b = buffer();
        assert!(b.reload("agent".into(), "v2".into()));
        assert!(!b.dirty());
        assert_eq!(b.version, "v2");
    }
    #[test]
    fn unchanged_poll_does_not_report_dirty_buffer_conflict() {
        let mut b = buffer();
        b.text = "user".into();
        assert!(b.reload("before".into(), "v1".into()));
        assert!(b.conflict.is_none());
        assert_eq!(b.text, "user");
    }
    #[test]
    fn resolving_conflict_keeps_local_edits_and_rebases_version() {
        let mut b = buffer();
        b.text = "user".into();
        b.reload("agent".into(), "v2".into());
        b.resolve_external(false);
        assert_eq!(b.text, "user");
        assert_eq!(b.saved, "agent");
        assert_eq!(b.version, "v2");
        assert!(b.dirty());
        assert!(b.conflict.is_none());
    }
    #[test]
    fn resolving_conflict_can_accept_latest_disk_content() {
        let mut b = buffer();
        b.text = "user".into();
        b.reload("agent".into(), "v2".into());
        b.resolve_external(true);
        assert_eq!(b.text, "agent");
        assert!(!b.dirty());
    }
    #[test]
    fn lsp_handles_korean_and_surrogate_pairs() {
        let text = "가😀x\nname";
        assert_eq!(lsp_position(text, 3), (0, 4));
        assert_eq!(lsp_byte_offset(text, 0, 3), Some(7));
        assert_eq!(lsp_byte_offset(text, 0, 2), None);
        assert_eq!(lsp_byte_offset(text, 1, 2), Some(11));
    }
    #[test]
    fn completion_applies_utf16_range() {
        let mut text = "가😀x".to_owned();
        let item = serde_json::json!({"textEdit":{"range":{"start":{"line":0,"character":3},"end":{"line":0,"character":4}},"newText":"value"}});
        apply_completion(&mut text, &item, 0).unwrap();
        assert_eq!(text, "가😀value");
    }
    #[test]
    fn completion_replaces_identifier() {
        let mut text = "foo.ba".to_owned();
        apply_completion(&mut text, &serde_json::json!({"label":"bar"}), 6).unwrap();
        assert_eq!(text, "foo.bar");
    }
}
