export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/self-test") {
      return html(selfTestPage());
    }

    if (request.method === "POST" && url.pathname === "/api/self-test") {
      return cors(await runSelfTest(env));
    }

    const match = url.pathname.match(/^\/api\/rooms\/([a-z0-9_-]{3,64})(?:\/claims(?:\/(\d+))?)?$/i);
    if (!match) return cors(json({ error: "Not found" }, 404));

    const roomId = match[1];
    const xid = match[2] || null;
    const secret = request.headers.get("x-ks-room-secret") || "";

    if (secret.length < 8) {
      return cors(json({ error: "Room secret must contain at least 8 characters" }, 400));
    }

    const secretKey = `room:${roomId}:secret`;
    const claimsKey = `room:${roomId}:claims`;

    const storedSecret = await env.DIBS_KV.get(secretKey);
    if (!storedSecret) {
      await env.DIBS_KV.put(secretKey, secret);
    } else if (storedSecret !== secret) {
      return cors(json({ error: "Invalid room secret" }, 403));
    }

    let claims = {};
    try {
      claims = JSON.parse((await env.DIBS_KV.get(claimsKey)) || "{}");
    } catch {
      claims = {};
    }

    if (request.method === "GET" && !xid) {
      return cors(json({ claims }));
    }

    if (request.method === "PUT" && xid) {
      const body = await request.json().catch(() => ({}));
      const ownerAlias = clean(body.ownerAlias, 40);
      const targetName = clean(body.targetName, 80);

      if (!ownerAlias || !targetName) {
        return cors(json({ error: "Invalid claim data" }, 400));
      }

      const existing = claims[xid];
      if (existing && existing.ownerAlias !== ownerAlias) {
        return cors(json({ error: "Target already claimed", claim: existing }, 409));
      }

      claims[xid] = {
        xid,
        targetName,
        ownerAlias,
        claimedAt: Date.now()
      };

      await env.DIBS_KV.put(claimsKey, JSON.stringify(claims));
      return cors(json({ claim: claims[xid] }));
    }

    if (request.method === "DELETE" && xid) {
      delete claims[xid];
      await env.DIBS_KV.put(claimsKey, JSON.stringify(claims));
      return cors(json({ released: xid }));
    }

    return cors(json({ error: "Method not allowed" }, 405));
  }
};

async function runSelfTest(env) {
  const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const roomId = `selftest-${stamp}`;
  const xid = String(900000000 + Math.floor(Math.random() * 99999999));
  const secretKey = `room:${roomId}:secret`;
  const claimsKey = `room:${roomId}:claims`;
  const secret = `selftest-${crypto.randomUUID()}`;
  const steps = [];

  try {
    await env.DIBS_KV.put(secretKey, secret);
    const storedSecret = await env.DIBS_KV.get(secretKey);
    steps.push({
      step: "secret_write_read",
      pass: storedSecret === secret
    });

    const claim = {
      xid,
      targetName: "KS Backend Self-Test Target",
      ownerAlias: "Kingshade",
      claimedAt: Date.now()
    };

    await env.DIBS_KV.put(claimsKey, JSON.stringify({ [xid]: claim }));

    const storedClaims = JSON.parse((await env.DIBS_KV.get(claimsKey)) || "{}");
    steps.push({
      step: "claim_write_read",
      pass:
        storedClaims[xid]?.xid === xid &&
        storedClaims[xid]?.ownerAlias === "Kingshade"
    });

    delete storedClaims[xid];
    await env.DIBS_KV.put(claimsKey, JSON.stringify(storedClaims));

    const afterRelease = JSON.parse((await env.DIBS_KV.get(claimsKey)) || "{}");
    steps.push({
      step: "claim_release",
      pass: !afterRelease[xid]
    });

    const pass = steps.every(step => step.pass);

    return json({
      status: pass ? "PASS" : "FAIL",
      version: "0.1.0-alpha.21",
      checks: steps,
      message: pass
        ? "Worker and KV lifecycle are functioning."
        : "One or more KV lifecycle checks failed."
    }, pass ? 200 : 500);
  } catch (error) {
    return json({
      status: "FAIL",
      version: "0.1.0-alpha.21",
      checks: steps,
      error: String(error?.message || error)
    }, 500);
  } finally {
    await Promise.allSettled([
      env.DIBS_KV.delete(secretKey),
      env.DIBS_KV.delete(claimsKey)
    ]);
  }
}

function selfTestPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>KS Live Dibs Backend Test</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      background: #0d0f12;
      color: #f4f4f4;
      font: 16px/1.45 system-ui, sans-serif;
    }
    main {
      width: min(100%, 520px);
      padding: 22px;
      border: 1px solid #3b4149;
      border-radius: 16px;
      background: #15191e;
    }
    h1 { margin: 0 0 6px; font-size: 24px; }
    p { color: #bfc6ce; }
    button {
      width: 100%;
      min-height: 52px;
      margin: 14px 0;
      border: 0;
      border-radius: 12px;
      background: #24733f;
      color: white;
      font: inherit;
      font-weight: 800;
    }
    button:disabled { opacity: .55; }
    pre {
      min-height: 100px;
      padding: 14px;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      border-radius: 10px;
      background: #090b0d;
    }
    .pass { border-left: 5px solid #45b96c; }
    .fail { border-left: 5px solid #df5555; }
  </style>
</head>
<body>
  <main>
    <h1>KS Live Dibs</h1>
    <p>Server-side Worker and KV lifecycle verification.</p>
    <button id="run">Run backend self-test</button>
    <pre id="result">Not tested.</pre>
  </main>
  <script>
    const button = document.getElementById("run");
    const result = document.getElementById("result");

    button.addEventListener("click", async () => {
      button.disabled = true;
      result.className = "";
      result.textContent = "Testing...";

      try {
        const response = await fetch("/api/self-test", { method: "POST" });
        const data = await response.json();
        result.className = data.status === "PASS" ? "pass" : "fail";
        result.textContent = JSON.stringify(data, null, 2);
      } catch (error) {
        result.className = "fail";
        result.textContent = "FAIL\\n" + String(error);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function clean(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "https://www.torn.com");
  headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,x-ks-room-secret");
  headers.set("cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    headers
  });
}
