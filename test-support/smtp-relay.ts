// Disposable SMTP relay: capture only, no mail is forwarded.
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const messages: {
  from: string;
  to: string[];
  authenticated: boolean;
  data: string;
}[] = [];
const sink = createServer((socket) => {
  socket.write("220 fixture ESMTP\r\n");
  let buffer = "";
  let from = "";
  let to: string[] = [];
  let authenticated = false;
  let data = "";
  let readingData = false;
  let authLogin = 0;
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let end = buffer.indexOf("\r\n");
    while (end !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (readingData) {
        if (line === ".") {
          messages.push({ from, to, authenticated, data });
          readingData = false;
          socket.write("250 queued\r\n");
        } else data += `${line}\n`;
      } else if (authLogin > 0) {
        if (authLogin === 1) {
          authenticated =
            Buffer.from(line, "base64").toString() === "fixture-user";
          authLogin = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else {
          authenticated &&=
            Buffer.from(line, "base64").toString() === "fixture-secret";
          authLogin = 0;
          socket.write(
            authenticated ? "235 authenticated\r\n" : "535 denied\r\n",
          );
        }
      } else if (/^EHLO /i.test(line))
        socket.write("250-fixture\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (/^AUTH PLAIN /i.test(line)) {
        authenticated =
          Buffer.from(line.split(" ")[2] ?? "", "base64").toString() ===
          "\0fixture-user\0fixture-secret";
        socket.write(
          authenticated ? "235 authenticated\r\n" : "535 denied\r\n",
        );
      } else if (/^AUTH LOGIN/i.test(line)) {
        authLogin = 1;
        socket.write("334 VXNlcm5hbWU6\r\n");
      } else if (/^MAIL FROM:/i.test(line)) {
        from = line;
        to = [];
        data = "";
        socket.write("250 ok\r\n");
      } else if (/^RCPT TO:/i.test(line)) {
        to.push(line);
        socket.write("250 ok\r\n");
      } else if (line === "DATA") {
        readingData = true;
        socket.write("354 continue\r\n");
      } else if (line === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
      end = buffer.indexOf("\r\n");
    }
  });
});
sink.listen(2525, "0.0.0.0");
createHttpServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(messages));
}).listen(8081, "0.0.0.0");
