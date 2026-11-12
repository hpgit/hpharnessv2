use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::Value;
use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver},
    },
};

pub struct Terminal {
    pub session: String,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    rx: Receiver<Vec<u8>>,
    parser: vt100::Parser,
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
impl Terminal {
    pub fn start(
        session: &str,
        cwd: &str,
        target: &Value,
        ctx: eframe::egui::Context,
    ) -> Result<Self, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 110,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut command = if target["kind"] == "ssh" {
            let host = target["host"].as_str().ok_or("SSH host missing")?;
            if host.starts_with('-') {
                return Err("Invalid SSH host".into());
            }
            let mut cmd = CommandBuilder::new("ssh");
            cmd.args(["-tt", host]);
            let script = if let Some(container) = target["container"].as_str() {
                format!(
                    "docker exec -it -w {} {} /bin/sh",
                    quote(cwd),
                    quote(container)
                )
            } else {
                format!("cd {} && exec \"${{SHELL:-/bin/sh}}\"", quote(cwd))
            };
            cmd.arg(script);
            cmd
        } else {
            #[cfg(windows)]
            let mut cmd = {
                let mut c = CommandBuilder::new("powershell.exe");
                c.args(["-NoLogo", "-NoProfile"]);
                c
            };
            #[cfg(not(windows))]
            let mut cmd =
                CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
            cmd.cwd(cwd);
            cmd
        };
        command.env("TERM", "xterm-256color");
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));
        let reply_writer = writer.clone();
        let (tx, rx) = mpsc::sync_channel(128);
        std::thread::spawn(move || {
            let mut data = [0; 8192];
            let mut cursor_query = Vec::new();
            while let Ok(size) = reader.read(&mut data) {
                if size == 0 {
                    break;
                }
                cursor_query.extend_from_slice(&data[..size]);
                if cursor_query.windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = reply_writer.lock().unwrap().write_all(b"\x1b[1;1R");
                }
                if cursor_query.len() > 3 {
                    cursor_query = cursor_query[cursor_query.len() - 3..].to_vec();
                }
                if tx.send(data[..size].to_vec()).is_err() {
                    break;
                }
                ctx.request_repaint();
            }
        });
        // ConPTY may synchronously ask the terminal for its initial cursor position
        // while CreateProcess is running. The reader/reply pump must already exist.
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);
        Ok(Self {
            session: session.into(),
            master: pair.master,
            child,
            writer,
            rx,
            parser: vt100::Parser::new(24, 110, 2000),
        })
    }
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.writer
            .lock()
            .map_err(|e| e.to_string())?
            .write_all(bytes)
            .map_err(|e| e.to_string())
    }
    pub fn contents(&mut self) -> String {
        while let Ok(bytes) = self.rx.try_recv() {
            self.parser.process(&bytes)
        }
        self.parser.screen().contents()
    }
    pub fn resize(&mut self, rows: u16, cols: u16) {
        let rows = rows.max(4);
        let cols = cols.max(20);
        if self.parser.screen().size() != (rows, cols) {
            let _ = self.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            self.parser.set_size(rows, cols);
        }
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_quoting_keeps_spaces_and_quotes() {
        assert_eq!(quote("a'b c"), "'a'\"'\"'b c'");
    }
    #[test]
    fn terminal_handles_overwrite_and_ansi() {
        let mut parser = vt100::Parser::new(3, 20, 0);
        parser.process(b"old\r\x1b[2Knew\r\n\x1b[31mred");
        assert_eq!(parser.screen().contents(), "new\nred");
    }
    #[test]
    fn native_pty_shell_roundtrip() {
        let cwd = std::env::current_dir().unwrap();
        let mut pty = Terminal::start(
            "test",
            &cwd.to_string_lossy(),
            &serde_json::json!({"kind":"local"}),
            eframe::egui::Context::default(),
        )
        .unwrap();
        #[cfg(windows)]
        let command = "Write-Output ('HPH_' + 'PTY_OK')\r";
        #[cfg(not(windows))]
        let command = "printf '%s%s\\n' HPH_ PTY_OK\r";
        pty.write(command.as_bytes()).unwrap();
        let start = std::time::Instant::now();
        let mut output = String::new();
        while start.elapsed() < std::time::Duration::from_secs(10) {
            output = pty.contents();
            if output.lines().any(|line| line.trim() == "HPH_PTY_OK") {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        panic!("Native PTY did not return expected output: {output}");
    }
}
