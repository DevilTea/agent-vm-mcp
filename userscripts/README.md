# Browser userscripts

These scripts are optional local-browser companions. They are not part of the
`agent-vm-mcp` server process and must not move browser authentication state to
the Agent VM.

## ChatGPT native auto-continue

`chatgpt-native-auto-continue.user.js` is the conservative v1 implementation
for issue #17. Install it in a userscript manager such as Tampermonkey or
Violentmonkey in the browser where you normally use ChatGPT.

Direct install/update URL:

`https://raw.githubusercontent.com/DevilTea/agent-vm-mcp/main/userscripts/chatgpt-native-auto-continue.user.js`

The script adds a small `Auto Continue` toggle. Enablement is scoped to an
existing `/c/<conversation-id>` ChatGPT conversation and defaults to off. New
chat and other non-conversation routes cannot enable or inherit the feature.
When enabled, the script only clicks an explicit, visible native
`Continue generating` control. It never creates a new `continue` user message
and does not treat ordinary generation completion as an interruption.

Safety behavior:

- required `localStorage`/`sessionStorage` failure disables automatic
  continuation instead of resetting safety state; the failure remains latched
  for the current page lifetime so userscript re-evaluation cannot recover from
  stale persisted safety state;
- exactly one raw `#prompt-textarea` candidate must exist and that sole candidate
  must be visible and usable; missing, hidden, or any duplicate composer DOM
  fails closed;
- automatic continuation is suppressed while that composer contains text or a
  recognized attachment; arbitrary future attachment DOM is a compatibility
  limitation rather than something the script claims to infer safely;
- a native continuation control is revalidated after a short settle period and
  must still be the only matching unused visible control;
- each consumed DOM control is marked and excluded from later candidate
  matching so an old retained control neither re-clicks nor creates false
  ambiguity;
- a continuation chain is capped at eight automatic clicks and stored per
  conversation for the browser tab/session; toggling, SPA navigation, and
  userscript re-evaluation do not reset the counter;
- Send/Enter/form-submit events only arm a submission intent. While that intent
  is pending, automatic continuation is suppressed and pre-existing continuation
  controls are consumed. The chain resets only after a new stable user-message
  identity appears in that same conversation; navigation cancels the intent and
  composer clearing or a Stop control alone never confirms submission;
- manually pressing a recognized ChatGPT Stop control suppresses automatic
  continuation until the Owner manually chooses `Continue generating` or a new
  same-conversation user message is confirmed;
- Stop recognition uses the known `data-testid="stop-button"` path plus a small
  exact-label/aria-label allowlist. A control carrying conflicting exact Continue
  and Stop semantics is treated as unknown and never auto-clicked. Unknown future
  ChatGPT Stop DOM intentionally remains a compatibility limitation rather than
  using fuzzy button matching;
- conversation navigation consumes any currently rendered Continue controls before
  loading the destination chat's state, and the transition reconcile returns immediately;
  this deliberately prefers a safe missed continuation over clicking stale DOM from the
  previous chat with the destination chat's safety state.

The same conservative rule applies to user-message identity: automatic chain
reset requires a stable `data-message-id` or `conversation-turn-*` identity. If
ChatGPT changes that DOM contract, the script preserves the existing safety
state rather than guessing that a prompt was submitted.

`chatgpt-native-auto-continue.acceptance.html` is a dependency-free synthetic
browser fixture for the state/DOM guards. Serve this directory over localhost
and open the fixture in a browser to run it. Real ChatGPT acceptance is still
required because ChatGPT's private DOM can change independently of this repo.
