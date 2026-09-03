# Milk Man on your own AWS Lambda (free, Node 22)

Free Alexa hosting only runs Node 16, which can't run this. Your own AWS Lambda runs Node 22 for
free (1M calls/month, forever) with nothing to maintain. No database, no permissions to set up —
the token and settings live in one encrypted setting on the function.

**You do Part A and B (about 15 min). Then send me the Lambda ARN and I finish the Alexa side.**

You need two files, both already on your Mac:
- `~/Downloads/milk-man-lambda-node22.zip` — the code (I sent it to you)
- `~/.blinkit-mcp/blinkit-session.env.txt` — one line with your token + settings (private)

---

## Part A — Create the AWS account (skip if you have one)

1. Go to **aws.amazon.com** → **Create an AWS Account**.
2. Email, account name, then verify. Set a root password.
3. Enter a card (required for identity; this setup never gets charged).
4. Verify your phone. Choose the **Basic (free)** support plan.
5. Sign in to the **AWS Management Console** as root.
6. Top-right, set your Region to one near you, e.g. **Asia Pacific (Mumbai) ap-south-1**. Remember it.

---

## Part B — Create the Lambda

1. In the console search bar type **Lambda**, open it, click **Create function**.
2. **Author from scratch.** Function name: `milk-man`. Runtime: **Node.js 22.x**. Architecture: **x86_64**. Click **Create function**.
3. **Upload the code.** On the function page, **Code** tab → **Upload from** ▾ → **.zip file** → **Upload** → pick `~/Downloads/milk-man-lambda-node22.zip` → **Save**. (It's 7 MB; give it a few seconds.)
4. **Set the handler.** Same page, scroll to **Runtime settings** → **Edit** → Handler = `index.handler` → **Save**.
5. **Timeout + memory.** **Configuration** tab → **General configuration** → **Edit** → Timeout **0 min 10 sec**, Memory **512 MB** → **Save**.
6. **Paste your settings.** **Configuration** tab → **Environment variables** → **Edit** → **Add environment variable**:
   - Key: `BLINKIT_SESSION`
   - Value: open `~/.blinkit-mcp/blinkit-session.env.txt`, copy the whole single line, paste it here.
   - **Save**. (This holds your login token — that's why it stays only here, encrypted.)
7. **Let Alexa call it.** **Function overview** (top) → **Add trigger** → pick **Alexa Skills Kit**.
   - If it asks for a Skill ID, choose **Disable** skill ID verification for now (we lock it after). → **Add**.
8. **Copy the ARN.** Top-right of the function page, copy the **Function ARN**
   (looks like `arn:aws:lambda:ap-south-1:123456789012:function:milk-man`).

---

## Part C — send me the ARN

Paste the **Function ARN** back to me. I'll create the Alexa skill pointing at it, wire up the
"order milk" phrase, and we test it as text before you try it on the Echo.

---

## Quick self-test (optional, before the ARN)

On the Lambda page, **Test** tab → create a test event, paste this, **Test**:
```json
{ "version":"1.0","session":{"new":true,"application":{"applicationId":"x"},"user":{"userId":"u"}},
  "context":{"System":{"application":{"applicationId":"x"},"user":{"userId":"u"},"device":{"deviceId":"d","supportedInterfaces":{}}}},
  "request":{"type":"LaunchRequest","requestId":"r","timestamp":"2026-09-03T00:00:00Z","locale":"en-US"} }
```
A good result contains speech like *"…Vijaya Gold full cream milk … total … rupees … Shall I place the order?"*.
If it says it can't reach Blinkit, copy the error and send it to me.

## Later: refreshing the token
If the skill ever says "Blinkit has logged me out": on your Mac run
`node scripts/relogin.mjs <your-phone>`, then `node scripts/make-env.mjs`, and paste the new line
into the same `BLINKIT_SESSION` variable (Configuration → Environment variables → Edit).
