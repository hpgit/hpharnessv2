use serde_json::{Value, json};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::Duration,
};
const MAX: usize = 900_000;
fn read_frame(r: &mut impl Read) -> io::Result<Option<Value>> {
    let mut size = [0u8; 4];
    match r.read_exact(&mut size) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes(size) as usize;
    if n > MAX {
        return Err(io::Error::other("native message too large"));
    }
    let mut data = vec![0; n];
    r.read_exact(&mut data)?;
    Ok(Some(serde_json::from_slice(&data)?))
}
fn forward(m: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let method = m.get("method").and_then(Value::as_str).unwrap_or("");
    if ![
        "browser.poll",
        "browser.result",
        "browser.connected",
        "browser.handoff",
        "browser.release",
        "browser.validateLease",
    ]
    .contains(&method)
    {
        return Err("bridge method not allowed".into());
    }
    let data = std::env::var_os("HPH_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("USERPROFILE")
                    .or_else(|| std::env::var_os("HOME"))
                    .unwrap_or_default(),
            )
            .join(".hpharness")
        });
    let config: Value = serde_json::from_slice(&std::fs::read(data.join("daemon.json"))?)?;
    let port = config["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("invalid daemon port")?;
    let mut stream = TcpStream::connect(("127.0.0.1", port as u16))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let request = json!({"id":m["id"],"method":method,"params":m.get("params").cloned().unwrap_or(json!({})),"token":config["token"]});
    writeln!(stream, "{}", request)?;
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if reader.by_ref().take(MAX as u64 + 1).read_line(&mut line)? == 0 {
            return Err("daemon disconnected".into());
        }
        if line.len() > MAX {
            return Err("daemon response too large".into());
        }
        let response: Value = serde_json::from_str(&line)?;
        if response.get("id") == request.get("id") {
            return Ok(response);
        }
    }
}
fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(message) = read_frame(&mut input)? {
        let id = message["id"].clone();
        let result =
            forward(message).unwrap_or_else(|e| json!({"id":id,"error":{"message":e.to_string()}}));
        let data = serde_json::to_vec(&result)?;
        if data.len() > MAX {
            return Err(io::Error::other("native reply too large"));
        }
        output.write_all(&(data.len() as u32).to_le_bytes())?;
        output.write_all(&data)?;
        output.flush()?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing() {
        let data = br#"{"method":"browser.poll"}"#;
        let mut frame = (data.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(data);
        assert_eq!(
            read_frame(&mut frame.as_slice()).unwrap().unwrap()["method"],
            "browser.poll"
        );
    }
    #[test]
    fn reject_size() {
        assert!(read_frame(&mut (MAX as u32 + 1).to_le_bytes().as_slice()).is_err());
    }
}
