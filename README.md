# Gmail Daily Digest

Automated daily email digest that reads emails from multiple Gmail accounts, categorizes them using **Gemini AI**, and sends a styled HTML summary to your inbox.

Runs as a **Google Apps Script** project, triggered daily at 8 AM (America/Sao_Paulo).

## How it works

1. **Daily trigger** fires at 8 AM (configurable)
2. For each configured Gmail account:
   - Exchanges the stored **refresh token** for a fresh **access token** via Google OAuth
   - Calls **Gmail REST API** to fetch yesterday's emails (excluding spam, trash, promotions, social, forums)
   - Filters out blacklisted senders (newsletters, marketing, etc.)
3. Sends all emails to **Gemini 2.5 Flash** for categorization into:
   - **IMPORTANTE** - needs immediate action (financial, security, urgent work)
   - **INTERESSANTE** - worth reading later (project updates, relevant news)
   - **NAO_RELEVANTE** - informational, no action needed (confirmations, routine notifications)
   - **PARA_APAGAR** - clearly disposable (ads that passed filters, repetitive newsletters)
4. Sends a **mobile-friendly styled HTML email** to the configured recipient with stats, summary, and categorized emails with in-app Gmail links

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 Google Apps Script                  │
│                                                     │
│  ┌──────────┐    ┌───────────┐    ┌──────────────┐  │
│  │ OAuth    │───>│ Gmail API │───>│ Gemini AI    │  │
│  │ Token    │    │ (REST)    │    │ (categorize) │  │
│  │ Exchange │    │           │    │              │  │
│  └──────────┘    └───────────┘    └──────┬───────┘  │
│                                          │          │
│                                   ┌──────▼───────┐  │
│                                   │ HTML Email   │  │
│                                   │ (GmailApp)   │  │
│                                   └──────────────┘  │
└─────────────────────────────────────────────────────┘

Accounts: configured via ACCOUNTS_CONFIG property
Secrets:  Script Properties (not in code)
```

## Project structure

```
gmail-daily-digest/
├── Code.gs            # Main script (~580 lines)
├── appsscript.json    # Apps Script manifest (timezone, scopes)
├── .clasp.json        # clasp deployment config (script ID)
└── README.md
```

### Code.gs sections

| Function | Description |
|----------|-------------|
| `dailyEmailDigest()` | Main entry point. Loops through all accounts, fetches, categorizes, sends digest |
| `getAccessToken_()` | Exchanges refresh token for access token via Google OAuth endpoint |
| `fetchYesterdayEmails_()` | Lists and fetches email details via Gmail REST API |
| `getMessageBody_()` | Decodes base64 email body (text/plain, html fallback, recursive multipart) |
| `categorizeWithGemini_()` | Sends emails to Gemini 2.5 Flash, returns categorized JSON |
| `sendDigestEmail_()` | Builds and sends styled HTML digest email |
| `buildHtmlEmail_()` | Generates mobile-responsive HTML template with stats and categorized sections |
| `setupDailyTrigger()` | Creates daily trigger at 8 AM (America/Sao_Paulo) |
| `removeTriggers()` | Removes all project triggers |
| `setupCredentials()` | Instructions for setting up Script Properties |

## Configuration

### Prerequisites

- [Node.js](https://nodejs.org/) installed
- [clasp](https://github.com/google/clasp) CLI: `npm install -g @google/clasp`
- A Google Cloud project with:
  - Gmail API enabled
  - Generative Language API enabled
  - OAuth 2.0 client credentials (Desktop type)
  - Gemini API key (restricted to Generative Language API only)

### 1. Clone and deploy

```bash
# Login to clasp with your Google account
clasp login

# Create a new Apps Script project (or use existing .clasp.json)
clasp create --title "Gmail Daily Digest" --type standalone

# Push the code
clasp push --force
```

### 2. Set up Script Properties

Go to the Apps Script editor > Configuracoes do projeto > Propriedades do script, and add:

| Property | Value |
|----------|-------|
| `GEMINI_API_KEY` | Your Gemini API key |
| `OAUTH_CLIENT_ID` | OAuth 2.0 client ID |
| `OAUTH_CLIENT_SECRET` | OAuth 2.0 client secret |
| `SUMMARY_RECIPIENT` | Email address to receive the digest |
| `ACCOUNTS_CONFIG` | Comma-separated list of `name:email` pairs (see example below) |
| `REFRESH_TOKEN_{NAME}` | Refresh token for each account (e.g. `REFRESH_TOKEN_WORK`) |

**ACCOUNTS_CONFIG example:**

```
work:you@company.com,personal:you@gmail.com,side:project@example.com
```

This will automatically look for `REFRESH_TOKEN_WORK`, `REFRESH_TOKEN_PERSONAL`, and `REFRESH_TOKEN_SIDE` in Script Properties.

Or run `setupCredentials()` from the editor for instructions.

### 3. Get refresh tokens

Use [gmail-cli](https://github.com/your-repo/gmail-cli) or any OAuth flow to obtain refresh tokens for each account:

```bash
~/bin/gmail auth <account-name>
```

Extract refresh tokens from the pickle files:

```bash
python3 -c "
import pickle
account = 'your-account'
with open(f'~/.config/gmail-cli/accounts/{account}/token.pickle', 'rb') as f:
    creds = pickle.load(f)
    print(creds.refresh_token)
"
```

### 4. Set up the trigger

Run `setupDailyTrigger` from the Apps Script editor. This creates a daily trigger at 8 AM (America/Sao_Paulo).

### 5. OAuth scopes required

Defined in `appsscript.json`:

- `gmail.readonly` - Read emails from all accounts via REST API
- `gmail.send` - Send digest email from the owner account
- `script.external_request` - Call Gemini API and Gmail REST API
- `script.scriptapp` - Manage triggers

## Email template features

- **Mobile-responsive** layout with viewport meta tag and proper text wrapping
- **Compact stats bar** that fits 4 categories on small screens
- **In-app Gmail links** — clicking an email subject opens it within the Gmail app instead of the browser
- **Color-coded sections**: red (important), blue (interesting), gray (informational), orange (to delete)
- **Account badges** to distinguish emails from different accounts

## Running locally

### Test via clasp

```bash
# Push latest code
clasp push --force

# Open the script editor in browser
clasp open
```

Then select `testDigest` from the function dropdown and click **Executar**.

### View execution logs

```bash
# Watch logs in real-time
clasp logs --watch
```

Or go to the Apps Script editor > Execucoes to see execution history.

### Manual test from editor

1. Open the script editor: `clasp open`
2. Select `testDigest` from the function dropdown
3. Click **Executar**
4. Check **Registro de execucao** for logs
5. Check your inbox for the digest emails

## Customization

### Add/remove accounts

Update the `ACCOUNTS_CONFIG` Script Property. Format: `name:email` pairs separated by commas:

```
personal:you@gmail.com,work:you@company.com
```

Then add a `REFRESH_TOKEN_{NAME}` property for each account (e.g. `REFRESH_TOKEN_PERSONAL`, `REFRESH_TOKEN_WORK`).

### Modify blacklist

Edit `CONFIG.BLACKLIST` to add/remove senders or domains to filter out.

### Change trigger time

Edit `setupDailyTrigger()` and change `.atHour(8)` to your desired hour, then run the function again.

### Change Gemini model

Edit `CONFIG.GEMINI_MODEL` (default: `gemini-2.5-flash`).
