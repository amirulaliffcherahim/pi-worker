// Lead mode is opt-in per session. pi-lead-gate flips this flag when the user types /lead.
// With the flag off, nothing in this fork changes normal single-agent behaviour.
export const LEAD_MODE_ENV = "PI_LEAD_MODE";
export function isLeadMode() {
    return process.env[LEAD_MODE_ENV] === "1";
}
