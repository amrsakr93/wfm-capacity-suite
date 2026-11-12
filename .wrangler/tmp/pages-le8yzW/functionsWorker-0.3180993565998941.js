var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../lib/auth-core.ts
var SESSION_COOKIE_NAME = "wfm_session";
var SESSION_TTL_SEC = 12 * 60 * 60;
var DEMO_OTP_TTL_SEC = 10 * 60;
var EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var cachedDemoSecret = null;
function resolveAuthMode(env) {
  const hasPaUrls = Boolean(env.PA_SEND_OTP_URL?.trim() && env.PA_VERIFY_OTP_URL?.trim());
  if (hasPaUrls && env.AUTH_MODE !== "demo") {
    return "power_automate";
  }
  if (env.AUTH_MODE === "demo") {
    return "demo";
  }
  return "unconfigured";
}
__name(resolveAuthMode, "resolveAuthMode");
function getSigningSecret(env, mode) {
  const explicit = env.SESSION_SECRET?.trim();
  if (explicit && explicit.length >= 16) return explicit;
  if (mode === "power_automate") {
    throw new Error("SESSION_SECRET (>=16 chars) is required in power_automate mode.");
  }
  if (!cachedDemoSecret) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    cachedDemoSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return cachedDemoSecret;
}
__name(getSigningSecret, "getSigningSecret");
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(toBase64Url, "toBase64Url");
function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
__name(fromBase64Url, "fromBase64Url");
async function importHmacKey(secret) {
  return globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
__name(importHmacKey, "importHmacKey");
async function sha256Hex(input) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
__name(timingSafeEqualBytes, "timingSafeEqualBytes");
async function signPayload(payload, secret) {
  const data = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const sigBuf = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${toBase64Url(new Uint8Array(sigBuf))}`;
}
__name(signPayload, "signPayload");
async function verifySignedPayload(token, secret, nowSec = Math.floor(Date.now() / 1e3)) {
  if (!token || !token.includes(".")) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  try {
    const key = await importHmacKey(secret);
    const expectedBuf = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(data));
    const expectedBytes = new Uint8Array(expectedBuf);
    const actualBytes = fromBase64Url(sig);
    if (!timingSafeEqualBytes(actualBytes, expectedBytes)) {
      return null;
    }
    const parsed = JSON.parse(decoder.decode(fromBase64Url(data)));
    if (typeof parsed.exp !== "number" || parsed.exp < nowSec) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
__name(verifySignedPayload, "verifySignedPayload");
function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}
__name(parseCookies, "parseCookies");
function buildCookieString(value, maxAgeSec, isHttps) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}
__name(buildCookieString, "buildCookieString");
function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmed) || trimmed.length > 200) return null;
  return trimmed;
}
__name(normalizeEmail, "normalizeEmail");
function normalizeChannel(raw) {
  if (raw === "outlook" || raw === "teams" || raw === "both") return raw;
  return "both";
}
__name(normalizeChannel, "normalizeChannel");
function randomSixDigitCode() {
  const arr = new Uint32Array(1);
  globalThis.crypto.getRandomValues(arr);
  return String(1e5 + arr[0] % 9e5);
}
__name(randomSixDigitCode, "randomSixDigitCode");
async function handleRequestOtp(body, env, fetchFn = fetch) {
  const mode = resolveAuthMode(env);
  if (mode === "unconfigured") {
    return {
      status: 503,
      body: {
        error: "AUTH_NOT_CONFIGURED",
        message: "Power Automate webhooks (PA_SEND_OTP_URL / PA_VERIFY_OTP_URL) are not configured and AUTH_MODE is not set to demo."
      }
    };
  }
  const email = normalizeEmail(body.email);
  if (!email) {
    return {
      status: 400,
      body: { error: "INVALID_EMAIL", message: "Please enter a valid corporate email address." }
    };
  }
  const channel = normalizeChannel(body.channel);
  if (mode === "demo") {
    const secret = getSigningSecret(env, mode);
    const code = randomSixDigitCode();
    const now = Math.floor(Date.now() / 1e3);
    const codeHash = await sha256Hex(`${email}:${code}`);
    const challengeToken = await signPayload(
      {
        email,
        codeHash,
        channel,
        exp: now + DEMO_OTP_TTL_SEC
      },
      secret
    );
    return {
      status: 200,
      body: {
        sent: true,
        mode: "demo",
        email,
        channel,
        expiresInSec: DEMO_OTP_TTL_SEC,
        challengeToken,
        demoCodePreview: code
      }
    };
  }
  const sendUrl = env.PA_SEND_OTP_URL.trim();
  const headers = { "Content-Type": "application/json" };
  if (env.PA_SHARED_SECRET?.trim()) {
    headers["x-wfm-secret"] = env.PA_SHARED_SECRET.trim();
  }
  try {
    const paRes = await fetchFn(sendUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email,
        channel,
        requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
        appName: "WFM & Capacity Suite"
      })
    });
    const text = await paRes.text();
    let parsed = {};
    try {
      if (text) parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    if (!paRes.ok || parsed.sent === false || parsed.authorized === false) {
      return {
        status: paRes.status >= 400 && paRes.status < 500 ? paRes.status : 403,
        body: {
          error: "OTP_DELIVERY_REJECTED",
          message: typeof parsed.message === "string" && parsed.message || "Email not authorized or Power Automate rejected OTP request."
        }
      };
    }
    return {
      status: 200,
      body: {
        sent: true,
        mode: "power_automate",
        email,
        channel,
        expiresInSec: DEMO_OTP_TTL_SEC
      }
    };
  } catch (err) {
    return {
      status: 502,
      body: {
        error: "PA_UNREACHABLE",
        message: `Unable to reach Power Automate SendOTP endpoint: ${err instanceof Error ? err.message : "Network error"}`
      }
    };
  }
}
__name(handleRequestOtp, "handleRequestOtp");
async function handleVerifyOtp(body, env, isHttps, fetchFn = fetch) {
  const mode = resolveAuthMode(env);
  if (mode === "unconfigured") {
    return {
      status: 503,
      body: { error: "AUTH_NOT_CONFIGURED", message: "Authentication server is not configured." }
    };
  }
  const email = normalizeEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!email || !/^[a-zA-Z0-9]{4,12}$/.test(code)) {
    return {
      status: 400,
      body: { error: "INVALID_INPUT", message: "Valid email and 4-12 character verification code required." }
    };
  }
  let secret;
  try {
    secret = getSigningSecret(env, mode);
  } catch (err) {
    return {
      status: 503,
      body: { error: "MISCONFIGURED_SECRET", message: err instanceof Error ? err.message : "Missing SESSION_SECRET" }
    };
  }
  if (mode === "demo") {
    const token = typeof body.challengeToken === "string" ? body.challengeToken : "";
    const challenge = await verifySignedPayload(
      token,
      secret
    );
    if (!challenge || challenge.email !== email) {
      return {
        status: 401,
        body: { error: "EXPIRED_OR_INVALID_CHALLENGE", message: "OTP expired or invalid. Please request a new code." }
      };
    }
    const candidateHash = await sha256Hex(`${email}:${code}`);
    if (!timingSafeEqualBytes(encoder.encode(candidateHash), encoder.encode(challenge.codeHash))) {
      return {
        status: 401,
        body: { error: "CODE_MISMATCH", message: "Incorrect verification code." }
      };
    }
  } else {
    const verifyUrl = env.PA_VERIFY_OTP_URL.trim();
    const headers = { "Content-Type": "application/json" };
    if (env.PA_SHARED_SECRET?.trim()) {
      headers["x-wfm-secret"] = env.PA_SHARED_SECRET.trim();
    }
    try {
      const paRes = await fetchFn(verifyUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, code })
      });
      const text = await paRes.text();
      let parsed = {};
      try {
        if (text) parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
      const isValid = paRes.ok && (parsed.authenticated === true || parsed.valid === true || parsed.verified === true);
      if (!isValid) {
        return {
          status: 401,
          body: {
            error: "CODE_MISMATCH",
            message: typeof parsed.message === "string" && parsed.message || "Code does not match SharePoint List record or has expired."
          }
        };
      }
    } catch (err) {
      return {
        status: 502,
        body: {
          error: "PA_UNREACHABLE",
          message: `Unable to reach Power Automate VerifyOTP endpoint: ${err instanceof Error ? err.message : "Network error"}`
        }
      };
    }
  }
  const now = Math.floor(Date.now() / 1e3);
  const session = {
    email,
    mode,
    iat: now,
    exp: now + SESSION_TTL_SEC
  };
  const cookieToken = await signPayload(session, secret);
  return {
    status: 200,
    body: {
      authenticated: true,
      email,
      mode,
      expiresAt: new Date(session.exp * 1e3).toISOString()
    },
    cookies: [buildCookieString(cookieToken, SESSION_TTL_SEC, isHttps)]
  };
}
__name(handleVerifyOtp, "handleVerifyOtp");
async function handleGetSession(cookieHeader, env) {
  const mode = resolveAuthMode(env);
  if (mode === "unconfigured") {
    return {
      status: 200,
      body: { authenticated: false, mode: "unconfigured" }
    };
  }
  let secret;
  try {
    secret = getSigningSecret(env, mode);
  } catch {
    return { status: 200, body: { authenticated: false, mode } };
  }
  const cookies = parseCookies(cookieHeader);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  const session = rawToken ? await verifySignedPayload(rawToken, secret) : null;
  if (!session) {
    return { status: 200, body: { authenticated: false, mode } };
  }
  return {
    status: 200,
    body: {
      authenticated: true,
      email: session.email,
      mode: session.mode,
      expiresAt: new Date(session.exp * 1e3).toISOString()
    }
  };
}
__name(handleGetSession, "handleGetSession");
function handleLogout(isHttps) {
  return {
    status: 200,
    body: { authenticated: false },
    cookies: [buildCookieString("", 0, isHttps)]
  };
}
__name(handleLogout, "handleLogout");
async function dispatchWebAuthRoute(route, request, env) {
  const url = new URL(request.url);
  const isHttps = url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  let result;
  try {
    if (route === "session") {
      result = await handleGetSession(request.headers.get("cookie"), env);
    } else if (route === "logout") {
      result = handleLogout(isHttps);
    } else if (request.method !== "POST") {
      result = { status: 405, body: { error: "METHOD_NOT_ALLOWED", message: "Use POST" } };
    } else {
      const body = await request.json().catch(() => ({}));
      result = route === "request-otp" ? await handleRequestOtp(body, env) : await handleVerifyOtp(body, env, isHttps);
    }
  } catch (err) {
    result = {
      status: 400,
      body: { error: "BAD_REQUEST", message: err instanceof Error ? err.message : "Invalid request" }
    };
  }
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  if (result.cookies) {
    for (const c of result.cookies) {
      headers.append("Set-Cookie", c);
    }
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers
  });
}
__name(dispatchWebAuthRoute, "dispatchWebAuthRoute");

// api/auth/logout.ts
async function onRequest(context) {
  return dispatchWebAuthRoute("logout", context.request, context.env);
}
__name(onRequest, "onRequest");

// api/auth/request-otp.ts
async function onRequest2(context) {
  return dispatchWebAuthRoute("request-otp", context.request, context.env);
}
__name(onRequest2, "onRequest");

// api/auth/session.ts
async function onRequest3(context) {
  return dispatchWebAuthRoute("session", context.request, context.env);
}
__name(onRequest3, "onRequest");

// api/auth/verify-otp.ts
async function onRequest4(context) {
  return dispatchWebAuthRoute("verify-otp", context.request, context.env);
}
__name(onRequest4, "onRequest");

// ../.wrangler/tmp/pages-le8yzW/functionsRoutes-0.07929002510864547.mjs
var routes = [
  {
    routePath: "/api/auth/logout",
    mountPath: "/api/auth",
    method: "",
    middlewares: [],
    modules: [onRequest]
  },
  {
    routePath: "/api/auth/request-otp",
    mountPath: "/api/auth",
    method: "",
    middlewares: [],
    modules: [onRequest2]
  },
  {
    routePath: "/api/auth/session",
    mountPath: "/api/auth",
    method: "",
    middlewares: [],
    modules: [onRequest3]
  },
  {
    routePath: "/api/auth/verify-otp",
    mountPath: "/api/auth",
    method: "",
    middlewares: [],
    modules: [onRequest4]
  }
];

// C:/Users/Amr Sakr/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// C:/Users/Amr Sakr/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function getOriginalPathPrefix(requestPath, normalizedPrefix) {
  let end = 0;
  for (let index = 0; index < normalizedPrefix.length; index++) {
    end++;
    if (normalizedPrefix[index] === "/") {
      while (requestPath[end] === "/") {
        end++;
      }
    }
  }
  return requestPath.slice(0, end);
}
__name(getOriginalPathPrefix, "getOriginalPathPrefix");
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  const normalizedRequestPath = requestPath.replace(/\/+/g, "/");
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath) || routeMatcher(normalizedRequestPath);
    const originalMountMatch = mountMatcher(requestPath);
    const mountMatchResult = originalMountMatch || mountMatcher(normalizedRequestPath);
    if (matchResult && mountMatchResult) {
      const path = originalMountMatch ? originalMountMatch.path : getOriginalPathPrefix(requestPath, mountMatchResult.path);
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
