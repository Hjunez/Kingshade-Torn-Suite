export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
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

function clean(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "https://www.torn.com");
  headers.set("access-control-allow-methods", "GET,PUT,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,x-ks-room-secret");
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    headers
  });
}
