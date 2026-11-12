use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver, Sender},
};

#[derive(Debug)]
pub enum Incoming {
    Message(Value),
    Error(String),
}

pub struct Client {
    tx: Sender<Value>,
    pub rx: Receiver<Incoming>,
    next_id: u64,
}

impl Client {
    pub fn launch(root: &Path, context: eframe::egui::Context) -> Self {
        let (tx, commands) = mpsc::channel::<Value>();
        let (events, rx) = mpsc::channel();
        let root = root.to_path_buf();
        std::thread::spawn(move || {
            let node = std::env::var_os("HPH_NODE").unwrap_or_else(|| "node".into());
            let entry = std::env::var_os("HPH_BACKEND")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| root.join("packages/harness/dist/main.js"));
            let mut cmd = Command::new(node);
            cmd.arg(entry)
                .current_dir(&root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(err) => {
                    let _ = events.send(Incoming::Error(format!("Backend launch failed: {err}. Run npm run build first; set HPH_NODE if Node is not in PATH.")));
                    context.request_repaint();
                    return;
                }
            };
            let Some(mut input) = child.stdin.take() else {
                return;
            };
            let Some(output) = child.stdout.take() else {
                return;
            };
            let writer_events = events.clone();
            std::thread::spawn(move || {
                for command in commands {
                    if let Err(err) = writeln!(input, "{command}").and_then(|_| input.flush()) {
                        let _ = writer_events
                            .send(Incoming::Error(format!("Backend disconnected: {err}")));
                        break;
                    }
                }
            });
            for line in BufReader::new(output).lines() {
                match line {
                    Ok(line) => match serde_json::from_str(&line) {
                        Ok(value) => {
                            let _ = events.send(Incoming::Message(value));
                        }
                        Err(_) => {
                            let _ = events.send(Incoming::Error(format!(
                                "Invalid backend response: {}",
                                line.chars().take(300).collect::<String>()
                            )));
                        }
                    },
                    Err(err) => {
                        let _ = events.send(Incoming::Error(err.to_string()));
                        break;
                    }
                }
                context.request_repaint();
            }
            let _ = events.send(Incoming::Error("Backend connection closed".into()));
            context.request_repaint();
            // Dropping Child never terminates remote jobs or the backend process.
        });
        Self { tx, rx, next_id: 1 }
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.tx
            .send(json!({"id":id,"method":method,"params":params}))
            .map_err(|e| e.to_string())?;
        Ok(id)
    }
}
