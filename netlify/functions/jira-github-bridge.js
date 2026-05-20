const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET;
const GITHUB_TOKEN        = process.env.GITHUB_BRIDGE_TOKEN;
const GITHUB_REPO         = process.env.GITHUB_REPO;           // e.g. "jyggiz/react-native-starter"
const JULES_USERNAME      = process.env.JULES_GITHUB_USERNAME; // e.g. "jules-google-labs[bot]"
const DEVELOPER_TEAM      = process.env.DEVELOPER_TEAM;        // e.g. "jyggiz,dev2,dev3"
const JIRA_BASE_URL       = process.env.JIRA_BASE_URL;         // e.g. "https://yourcompany.atlassian.net"

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Validate shared secret
  const secret = event.headers['x-jira-webhook-secret'];
  if (secret !== JIRA_WEBHOOK_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Only handle bug creation events
  const eventType = payload.webhookEvent;
  const issueType = payload.issue?.fields?.issuetype?.name;
  if (eventType !== 'jira:issue_created' || issueType !== 'Bug') {
    return { statusCode: 200, body: 'Skipped: not a bug creation event' };
  }

  const issue   = payload.issue;
  const key     = issue.key;                                 // e.g. "STEP-123"
  const fields  = issue.fields;
  const summary  = fields.summary ?? '';
  const priority = fields.priority?.name ?? 'Unknown';
  const reporter = fields.reporter?.displayName ?? 'Unknown';

  // JIRA description is Atlassian Document Format (ADF) — extract plain text
  const description = extractText(fields.description);
  const steps       = extractText(fields.customfield_10026); // adjust field ID for your JIRA
  const expected    = extractText(fields.customfield_10027); // adjust field ID for your JIRA
  const actual      = extractText(fields.customfield_10028); // adjust field ID for your JIRA

  // Build @mention list for hard-to-reproduce escalation
  const devMentions = (DEVELOPER_TEAM ?? '')
    .split(',')
    .map(u => `@${u.trim()}`)
    .filter(Boolean)
    .join(', ');

  const issueBody = `## Bug Report from JIRA

**JIRA Ticket**: [${key}](${JIRA_BASE_URL}/browse/${key})
**Priority**: ${priority}
**Reporter**: ${reporter}

### Description
${description || '_No description provided_'}

### Steps to Reproduce
${steps || '_Not specified_'}

### Expected Behavior
${expected || '_Not specified_'}

### Actual Behavior
${actual || '_Not specified_'}

---

@claude Please verify whether this bug exists in the current codebase.

**Instructions for Claude — pick exactly one of the three outcomes:**

**Outcome A — Bug confirmed in code:**
- Run: \`gh issue edit $ISSUE_NUMBER --add-label "confirmed-bug" --remove-label "needs-verification"\`
- Run: \`gh issue edit $ISSUE_NUMBER --add-assignee ${JULES_USERNAME}\`
- Comment: summarize where in the code the bug lives and confirm Jules has been assigned to fix it.

**Outcome B — Bug rejected (does not exist or already fixed):**
- Run: \`gh issue edit $ISSUE_NUMBER --add-label "invalid" --remove-label "needs-verification"\`
- Comment: explain the finding (already fixed, behaviour is intentional, etc.).

**Outcome C — Cannot verify without emulator/device (visual rendering, platform-specific crash, runtime-only behaviour):**
- Run: \`gh issue edit $ISSUE_NUMBER --add-label "hard-reproduce" --remove-label "needs-verification"\`
- If the bug is visual/UI: also run \`gh issue edit $ISSUE_NUMBER --add-label "visual"\`
- Comment tagging the team: "${devMentions} — this bug requires device or emulator testing to verify. Please reproduce manually and update the label to \`confirmed-bug\` or \`invalid\`."

(Replace \`$ISSUE_NUMBER\` above with the actual number of this GitHub issue.)

**Instructions for Jules (if assigned via Outcome A):**
- Fix the bug described above.
- Create a regression test at \`regression-tests/${key}.test.ts\` — skip ONLY for pure visual/UI bugs with no testable logic.
- Reference \`closes #$ISSUE_NUMBER\` in your PR description.`;

  // Create GitHub issue
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/issues`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: `[${key}] ${summary}`,
        body: issueBody,
        labels: ['bug', 'from-jira', 'needs-verification'],
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.error('GitHub API error:', text);
    return { statusCode: 500, body: `GitHub API error: ${response.status}` };
  }

  const created = await response.json();
  console.log(`Created GitHub issue #${created.number} for ${key}`);
  return { statusCode: 200, body: JSON.stringify({ github_issue: created.number }) };
};

/**
 * Recursively extracts plain text from Atlassian Document Format (ADF) nodes.
 * Falls back gracefully if the value is already a plain string.
 */
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) {
    return node.content.map(extractText).join('');
  }
  return '';
}