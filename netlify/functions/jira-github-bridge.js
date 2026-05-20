const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET;
const GITHUB_TOKEN        = process.env.GITHUB_BRIDGE_TOKEN;
const GITHUB_REPO         = process.env.GITHUB_REPO;           // e.g. "jyggiz/react-native-starter"
const DEVELOPER_TEAM      = process.env.DEVELOPER_TEAM;        // e.g. "jyggiz,dev2,dev3"
const JIRA_BASE_URL       = process.env.JIRA_BASE_URL;         // e.g. "https://yourcompany.atlassian.net"

exports.handler = async (event) => {
  console.log('[jira-github-bridge] Function triggered');
  console.log('[jira-github-bridge] Env vars present:', {
    JIRA_WEBHOOK_SECRET: !!JIRA_WEBHOOK_SECRET,
    GITHUB_BRIDGE_TOKEN: !!GITHUB_TOKEN,
    GITHUB_REPO:         GITHUB_REPO         ?? '(not set)',
    DEVELOPER_TEAM:      DEVELOPER_TEAM      ?? '(not set)',
    JIRA_BASE_URL:       JIRA_BASE_URL        ?? '(not set)',
  });

  if (event.httpMethod !== 'POST') {
    console.log('[jira-github-bridge] Rejected: wrong HTTP method:', event.httpMethod);
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Validate shared secret
  const secret = event.headers['x-jira-webhook-secret'];
  if (secret !== JIRA_WEBHOOK_SECRET) {
    console.warn('[jira-github-bridge] Rejected: invalid webhook secret');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  console.warn('[jira-github-bridge] INFO: event.body: ', event.body);

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    console.error('[jira-github-bridge] Rejected: invalid JSON body');
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const eventType = payload.webhookEvent;
  console.log('[jira-github-bridge] Jira event received:', eventType);
  console.log('[jira-github-bridge] Raw Jira payload:', JSON.stringify(payload, null, 2));

  const issue     = payload.issue;
  const fields    = issue?.fields ?? {};
  const key       = issue?.key ?? 'UNKNOWN';
  const issueType = fields.issuetype?.name;

  console.log('[jira-github-bridge] Issue key:', key);
  console.log('[jira-github-bridge] Issue type:', issueType);
  console.log('[jira-github-bridge] All issue fields:', JSON.stringify(fields, null, 2));

  // --- Route: bug creation ---
  if (eventType === 'jira:issue_created' && issueType === 'Bug') {
    console.log('[jira-github-bridge] Matched route: bug creation');
    return handleBugCreated({ key, fields });
  }

  // --- Route: label changed to 'mobile' ---
  if (eventType === 'jira:issue_updated') {
    const changelog = payload.changelog ?? {};
    console.log('[jira-github-bridge] Changelog:', JSON.stringify(changelog, null, 2));

    const labelChange = (changelog.items ?? []).find(
      item => item.field === 'labels' && item.toString?.split(' ').includes('mobile')
    );

    if (labelChange) {
      console.log('[jira-github-bridge] Matched route: label changed to "mobile"', labelChange);
      return handleMobileLabelAdded({ key, fields });
    }
  }

  console.log('[jira-github-bridge] Skipped: no matching route for event:', eventType, '/ issueType:', issueType);
  return { statusCode: 200, body: 'Skipped: no matching route' };
};

async function handleBugCreated({ key, fields }) {
  const summary  = fields.summary ?? '';
  const priority = fields.priority?.name ?? 'Unknown';
  const reporter = fields.reporter?.displayName ?? 'Unknown';

  const description = extractText(fields.description);
  const steps       = extractText(fields.customfield_10026); // adjust field ID for your JIRA
  const expected    = extractText(fields.customfield_10027); // adjust field ID for your JIRA
  const actual      = extractText(fields.customfield_10028); // adjust field ID for your JIRA

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
- Run: \`gh issue edit $ISSUE_NUMBER --add-label "confirmed-bug" --add-label "jules" --remove-label "needs-verification"\`
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

  return postGitHubIssue({
    title:  `[${key}] ${summary}`,
    body:   issueBody,
    labels: ['bug', 'from-jira', 'needs-verification'],
    jiraKey: key,
    routeTag: 'bug-creation',
  });
}

async function handleMobileLabelAdded({ key, fields }) {
  const summary  = fields.summary ?? '';
  const priority = fields.priority?.name ?? 'Unknown';
  const reporter = fields.reporter?.displayName ?? 'Unknown';
  const issueType = fields.issuetype?.name ?? 'Unknown';

  const description = extractText(fields.description);

  const devMentions = (DEVELOPER_TEAM ?? '')
    .split(',')
    .map(u => `@${u.trim()}`)
    .filter(Boolean)
    .join(', ');

  const issueBody = `## Mobile Issue from JIRA

**JIRA Ticket**: [${key}](${JIRA_BASE_URL}/browse/${key})
**Issue Type**: ${issueType}
**Priority**: ${priority}
**Reporter**: ${reporter}

### Description
${description || '_No description provided_'}

---

This issue was labeled **mobile** in JIRA and requires mobile-specific attention.

${devMentions ? `${devMentions} — please review this mobile issue and triage accordingly.` : ''}`;

  return postGitHubIssue({
    title:  `[${key}] [mobile] ${summary}`,
    body:   issueBody,
    labels: ['mobile', 'from-jira', 'needs-triage'],
    jiraKey: key,
    routeTag: 'mobile-label',
  });
}

async function postGitHubIssue({ title, body, labels, jiraKey, routeTag }) {
  console.log(`[jira-github-bridge] [${routeTag}] Posting GitHub issue for ${jiraKey}:`, { title, labels });

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
      body: JSON.stringify({ title, body, labels }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(`[jira-github-bridge] [${routeTag}] GitHub API error (${response.status}):`, text);
    return { statusCode: 500, body: `GitHub API error: ${response.status}` };
  }

  const created = await response.json();
  console.log(`[jira-github-bridge] [${routeTag}] GitHub issue #${created.number} created for ${jiraKey}`);
  return { statusCode: 200, body: JSON.stringify({ github_issue: created.number }) };
}

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
