/**
 * Runs a browser harness in headless Edge and prints the JSON the harness
 * stored in `data-harness`.
 *
 *   node test/run-harness.cjs harness-chat.html
 *
 * Edge's `--dump-dom` writes nothing on Windows (msedge.exe is a GUI
 * subsystem binary and does not attach to the console), so the harness is
 * served over HTTP instead: the project root is served statically, the page
 * is loaded from there, and the result is POSTed back to the same server.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const EDGE_CANDIDATES = [
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];

const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edge) {
	console.error("headless Edge not found");
	process.exit(2);
}

const projectRoot = path.resolve(__dirname, "..");
const name = process.argv[2] || "harness-chat.html";
const harness = path.resolve(__dirname, name);
if (!fs.existsSync(harness)) {
	console.error("harness not found: " + harness);
	process.exit(2);
}

const payload = { done: false, data: null, error: null };

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
	const url = (req.url || "").split("?")[0];
	if (url === "/__result") {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try {
				payload.data = JSON.parse(body);
			} catch (err) {
				payload.error = "bad payload: " + err.message;
			}
			payload.done = true;
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});
		return;
	}

	const file = path.join(projectRoot, url === "/" ? path.relative(projectRoot, harness) : url);
	if (!file.startsWith(projectRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found: " + url);
		return;
	}
	res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
	fs.createReadStream(file).pipe(res);
});

const fail = (message) => {
	console.error(message);
	try { server.close(); } catch (_) { /* ignore */ }
	process.exit(1);
};

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sb-harness-"));
	const rel = path.relative(projectRoot, harness).replace(/\\/g, "/");
	const child = spawn(
		edge,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			"--window-size=1600,1000",
			"--user-data-dir=" + profile,
			"http://127.0.0.1:" + port + "/" + rel
		],
		{ stdio: "ignore" }
	);

	const started = Date.now();
	const timeout = setInterval(() => {
		if (payload.done) {
			clearInterval(timeout);
			try { child.kill(); } catch (_) { /* ignore */ }
			try { server.close(); } catch (_) { /* ignore */ }
			if (payload.error) fail(payload.error);
			if (!payload.data) fail("harness produced no data");
			console.log(JSON.stringify(payload.data, null, 2));
			process.exit(0);
		}
		if (Date.now() - started > 90000) {
			clearInterval(timeout);
			try { child.kill(); } catch (_) { /* ignore */ }
			fail("harness timed out");
		}
	}, 150);
});
