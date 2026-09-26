// Error codes the server returns (step 8: the server sends codes, clients show the words from
// public/i18n.js as err.<code>). The English text here is only for logs and API users.
export const ERRORS = {
  name_required: "Please enter a name",
  name_too_long: "Name is too long",
  name_blocked: "That name can't be used",
  bad_request: "Invalid request",
  too_large: "Request too large",
  method: "Use POST",
  guest_invalid: "Guest token check failed",
  human_check: "Turnstile check failed",
  code_format: "Invite codes are 6 digits",
  code_not_found: "No room with that invite code",
  budget: "Today's usage limit is nearly reached; no new rooms",
  rate_limited: "Too many rooms created; try again later",
  not_found: "Not found",
} as const;
export type ErrorCode = keyof typeof ERRORS;

// JSON error response: {code, error, ...extra}
export function fail(code: ErrorCode, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ code, error: ERRORS[code], ...extra }), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
