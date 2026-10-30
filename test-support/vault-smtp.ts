import { createServer, type Server } from "node:net";
import { simpleParser, type ParsedMail } from "mailparser";

// A disposable SMTP sink bound only to the test fixture's Docker gateway.
export async function captureVaultMail(host: string) {
  const messages: Buffer[] = [];
  const server: Server = createServer((socket) => {
    let pending = "";
    let data: string[] | undefined;
    socket.setEncoding("utf8");
    socket.write("220 fixture ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let end = pending.indexOf("\r\n");
      while (end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            messages.push(Buffer.from(data.join("\r\n") + "\r\n"));
            data = undefined;
            socket.write("250 queued\r\n");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
        } else if (/^(EHLO|HELO) /i.test(line)) {
          socket.write("250-fixture\r\n250 8BITMIME\r\n");
        } else if (/^(MAIL FROM:|RCPT TO:|RSET)/i.test(line)) {
          socket.write("250 OK\r\n");
        } else if (/^DATA$/i.test(line)) {
          data = [];
          socket.write("354 End with <CRLF>.<CRLF>\r\n");
        } else if (/^QUIT$/i.test(line)) {
          socket.end("221 Bye\r\n");
        } else socket.write("500 Unsupported command\r\n");
        end = pending.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("SMTP bind failed");
  return {
    port: address.port,
    async take(): Promise<ParsedMail> {
      const message = messages.shift();
      if (!message) throw new Error("Expected an SMTP message");
      return simpleParser(message);
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
