import { afterEach, expect, test } from "bun:test"
import { kiroHeaders, type KiroCredentials } from "./auth"
import { explainKiroError, isExpiredToken } from "./fetch"

const creds = (kind: KiroCredentials["kind"]): KiroCredentials => ({
  kind,
  accessToken: "tok",
  expiresAt: Date.now() + 3600_000,
  authRegion: "us-east-1",
  region: "us-east-1",
  key: "k",
  raw: {},
})

const kiroError = (message: string, reason?: string) => JSON.stringify({ message, ...(reason ? { reason } : {}) })

afterEach(() => {
  delete process.env.KIRO_HTTP_USER_AGENT
})

test("kiroHeaders always sends an explicit, truthful user-agent", () => {
  const h = kiroHeaders(creds("idc"))
  expect(h["user-agent"]).toMatch(/^aws-sdk-js\/\S+ ua\/2\.1 .* opencode-kiro-provider\/\d+\.\d+\.\d+$/)
  expect(h["user-agent"]).not.toMatch(/^Bun\//)
  expect(h["user-agent"]).not.toContain("KiroIDE")
  expect(h["x-amz-user-agent"]).toContain("opencode-kiro-provider/")
  expect(h.TokenType).toBe("SSO_OIDC")
  expect(h.Authorization).toBe("Bearer tok")
})

test("kiroHeaders: override and extras", () => {
  process.env.KIRO_HTTP_USER_AGENT = "custom/1"
  const h = kiroHeaders(creds("social"), { Accept: "application/json" })
  expect(h["user-agent"]).toBe("custom/1")
  expect(h.Accept).toBe("application/json")
  expect(h.TokenType).toBeUndefined()
})

test("only token problems count as an expired login", () => {
  expect(isExpiredToken(401, "")).toBe(true)
  expect(isExpiredToken(403, kiroError("The bearer token included in the request is invalid."))).toBe(true)
  expect(isExpiredToken(403, kiroError("The security token included in the request is expired"))).toBe(true)
  // Valid token, call refused: a new token would not help.
  expect(isExpiredToken(403, kiroError("User is not authorized to make this call."))).toBe(false)
  expect(isExpiredToken(403, kiroError("Your subscription does not support this application. Please contact your administrator."))).toBe(false)
  expect(isExpiredToken(500, kiroError("token expired"))).toBe(false)
})

test("error messages quote Kiro and give a matching hint", () => {
  const denied = explainKiroError(403, kiroError("User is not authorized to make this call.", "ACCESS_DENIED"))
  expect(denied).toContain("User is not authorized to make this call. (ACCESS_DENIED)")
  expect(denied).toContain("KIRO_DEBUG=1")
  expect(denied).not.toContain("kiro-cli login")

  const expired = explainKiroError(403, kiroError("The bearer token included in the request is invalid."))
  expect(expired).toContain("kiro-cli login")

  expect(explainKiroError(429, kiroError("Too many requests"))).toContain("throttling")
  expect(explainKiroError(400, "not json")).toBe("Kiro 400: not json Rerun with KIRO_DEBUG=1 and check ~/.cache/opencode-kiro-provider/debug.log.")
})
