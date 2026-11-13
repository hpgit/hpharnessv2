use super::*;
use std::sync::mpsc::{Receiver, Sender};

fn app() -> (HarnessApp, Receiver<Value>, Sender<rpc::Incoming>) {
    let (client, requests, responses) = rpc::Client::test_pair();
    let mut app = HarnessApp::with_client(&egui::Context::default(), None, client);
    app.pending.clear();
    while requests.try_recv().is_ok() {}
    app.prefs.selected_session = "session".into();
    app.sessions =
        vec![json!({"id":"session","cwd":std::env::temp_dir(),"target":{"kind":"local"}})];
    (app, requests, responses)
}

fn reply(app: &mut HarnessApp, responses: &Sender<rpc::Incoming>, request: &Value, result: Value) {
    responses
        .send(rpc::Incoming::Message(
            json!({"id":request["id"],"result":result}),
        ))
        .unwrap();
    app.drain();
}

#[test]
fn saving_either_settings_form_synchronizes_the_other_from_the_accepted_response() {
    let (mut app, requests, responses) = app();
    app.apply_settings(json!({"provider":{"protocol":"responses","baseUrl":"http://localhost/v1","model":"old"},"maxAgents":4}));
    app.protocol = "anthropic".into();
    app.save_connection_settings();
    let request = requests.recv().unwrap();
    assert_eq!(request["method"], "settings.update");
    assert_eq!(request["params"]["provider"]["protocol"], "anthropic");
    reply(&mut app, &responses, &request, request["params"].clone());
    let mut advanced: Value = serde_json::from_str(&app.advanced_settings).unwrap();
    assert_eq!(advanced["provider"]["protocol"], "anthropic");
    assert_eq!(advanced["maxAgents"], 4);
    advanced["provider"]["protocol"] = json!("chat-completions");
    advanced["provider"]["model"] = json!("new");
    app.advanced_settings = advanced.to_string();
    app.save_advanced_settings();
    let request = requests.recv().unwrap();
    reply(&mut app, &responses, &request, request["params"].clone());
    assert_eq!(app.protocol, "chat-completions");
    assert_eq!(app.model, "new");
    // Saving the standard form afterwards must not restore its former values.
    app.save_connection_settings();
    let request = requests.recv().unwrap();
    assert_eq!(request["params"]["provider"]["model"], "new");
    assert_eq!(
        request["params"]["provider"]["protocol"],
        "chat-completions"
    );
}

#[test]
fn rejected_settings_do_not_replace_accepted_settings_or_erase_the_draft() {
    let (mut app, requests, responses) = app();
    let accepted = json!({"provider":{"protocol":"responses","model":"old"}});
    app.apply_settings(accepted.clone());
    app.advanced_settings = "{broken".into();
    app.save_advanced_settings();
    assert!(requests.try_recv().is_err());
    app.advanced_settings = json!({"provider":{"protocol":"invalid"}}).to_string();
    let draft = app.advanced_settings.clone();
    app.save_advanced_settings();
    let request = requests.recv().unwrap();
    responses
        .send(rpc::Incoming::Message(
            json!({"id":request["id"],"error":{"code":"INVALID","message":"invalid protocol"}}),
        ))
        .unwrap();
    app.drain();
    assert_eq!(app.settings, accepted);
    assert_eq!(app.protocol, "responses");
    assert_eq!(app.advanced_settings, draft);
}

#[test]
fn lsp_absolute_path_reuses_relative_buffer_preserving_unsaved_edits_and_navigation() {
    let (mut app, requests, responses) = app();
    app.buffers.push(Buffer {
        path: "example.py".into(),
        session: "session".into(),
        text: "unsaved".into(),
        saved: "disk".into(),
        version: "v1".into(),
        conflict: None,
        external: None,
    });
    app.lsp_session = "session".into();
    let absolute = std::env::temp_dir().join("example.py");
    let uri = url::Url::from_file_path(&absolute).unwrap();
    app.open_location(uri.as_str(), &json!({"line":3,"character":2}));
    let request = requests.recv().unwrap();
    reply(
        &mut app,
        &responses,
        &request,
        json!({"path":absolute,"content":"disk","version":"v1"}),
    );
    assert_eq!(app.buffers.len(), 1);
    assert_eq!(app.buffers[0].text, "unsaved");
    assert_eq!(app.goto, Some(("example.py".into(), 3, 2)));
    assert!(app.same_file("session", "./example.py", absolute.to_str().unwrap()));
    assert_eq!(app.buffer_index("different-session", "example.py"), None);
}

#[test]
fn remote_identity_preserves_case_and_backslashes() {
    assert_eq!(
        state::file_key("/work", "./lib/../a.py", true),
        state::file_key("/work", "/work/a.py", true)
    );
    assert_ne!(
        state::file_key("/work", "A.py", true),
        state::file_key("/work", "a.py", true)
    );
    assert_ne!(
        state::file_key("/work", r"dir\a.py", true),
        state::file_key("/work", "dir/a.py", true)
    );
}

#[test]
#[cfg(windows)]
fn windows_identity_handles_drive_case_and_separators() {
    assert_eq!(
        state::file_key(r"F:\Project", "a.py", false),
        state::file_key(r"F:\Project", "f:/project/./a.py", false)
    );
}

#[test]
fn managed_pyright_is_used_only_for_local_targets_with_an_installed_server() {
    let root = std::env::temp_dir().join(format!("hpharness-preset-test-{}", std::process::id()));
    let server = root.join(".tools/languages/node_modules/pyright/langserver.index.js");
    std::fs::create_dir_all(server.parent().unwrap()).unwrap();
    std::fs::write(&server, "// fixture").unwrap();
    let preset = json!({"id":"pyright","command":"pyright-langserver","args":["--stdio"]});
    let (command, args) = state::language_server(&preset, &root, "custom-node", true);
    assert_eq!(command, "custom-node");
    assert_eq!(
        serde_json::from_str::<Value>(&args).unwrap(),
        json!([server, "--stdio"])
    );
    assert_eq!(
        state::language_server(&preset, &root, "custom-node", false).0,
        "pyright-langserver"
    );
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(
        state::language_server(&preset, &root, "custom-node", true).0,
        "pyright-langserver"
    );
}

#[test]
fn file_polling_discovers_created_files_without_overlapping_or_stale_directory_results() {
    let (mut app, requests, responses) = app();
    app.left_tab = 1;
    app.refresh();
    let first = requests
        .try_iter()
        .collect::<Vec<_>>()
        .into_iter()
        .find(|r| r["method"] == "files.list")
        .unwrap();
    app.refresh();
    assert!(!requests.try_iter().any(|r| r["method"] == "files.list"));
    reply(&mut app, &responses, &first, json!([]));
    app.refresh();
    let second = requests
        .try_iter()
        .collect::<Vec<_>>()
        .into_iter()
        .find(|r| r["method"] == "files.list")
        .unwrap();
    reply(&mut app, &responses, &second, json!([{"name":"new.txt"}]));
    assert_eq!(app.files[0]["name"], "new.txt");
    app.file_dir = "old".into();
    app.refresh_files();
    let old = requests.recv().unwrap();
    app.file_dir = "new".into();
    app.refresh_files();
    let new = requests.recv().unwrap();
    reply(&mut app, &responses, &new, json!([{"name":"current.txt"}]));
    reply(&mut app, &responses, &old, json!([{"name":"stale.txt"}]));
    assert_eq!(app.files[0]["name"], "current.txt");
}

#[test]
fn command_result_replaces_previous_error_and_nonzero_exit_is_not_success() {
    let (mut app, requests, responses) = app();
    app.status = "invalid JSON".into();
    app.request("command.run", json!({}), Pending::Command);
    let request = requests.recv().unwrap();
    reply(
        &mut app,
        &responses,
        &request,
        json!({"exitCode":0,"status":"completed","stdout":"OK"}),
    );
    assert_eq!(app.status, "명령 실행 완료");
    assert!(app.terminal.contains("OK"));
    app.request("command.run", json!({}), Pending::Command);
    let request = requests.recv().unwrap();
    reply(
        &mut app,
        &responses,
        &request,
        json!({"exitCode":2,"status":"completed"}),
    );
    assert_eq!(app.status, "명령 실패 (종료 코드 2)");
}

#[test]
fn both_conflict_resolutions_clear_error_status_without_silently_saving() {
    let (mut app, _, _) = app();
    for use_disk in [false, true] {
        app.status = "VERSION_CONFLICT".into();
        app.buffers = vec![Buffer {
            path: "a.py".into(),
            session: "session".into(),
            text: "mine".into(),
            saved: "old".into(),
            version: "v1".into(),
            conflict: Some("conflict".into()),
            external: Some(("disk".into(), "v2".into())),
        }];
        app.resolve_conflict(use_disk, &egui::Context::default());
        assert!(app.status.starts_with("충돌 해소:"));
        assert_eq!(app.buffers[0].text, if use_disk { "disk" } else { "mine" });
        assert_eq!(app.buffers[0].dirty(), !use_disk);
        assert!(app.buffers[0].conflict.is_none());
    }
}
