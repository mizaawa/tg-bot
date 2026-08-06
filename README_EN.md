# Open Wegram Bot - OWB
## A Smooth-Operating Two-Way Private Messaging Telegram Bot 🤖 (Zero Cost)
### *LivegramBot stays alive, the battle will thrive!*

[简体中文](README.md) | English

This is a two-way private messaging Telegram bot based on Cloudflare Worker / Vercel that can be easily deployed without requiring a server, database, or your own domain name.

Users can send messages to you through your bot, and you can reply directly to these messages, enabling two-way communication.

## ✨ Features

- 🔄 **Two-Way Communication** - Easily receive and reply to messages from users
- 💾 **No Database Required** - Completely stateless design, zero storage costs
- 🌐 **No Personal Domain Required** - Use the free domain provided by Cloudflare Worker
- 🚀 **Lightweight Deployment** - Complete setup within minutes
- 💰 **Zero Running Cost** - Operates within Cloudflare's free plan limits
- 🔒 **Secure and Reliable** - Uses official Telegram API and secure tokens
- 🔌 **Multiple Bot Support** - Register multiple private chat bots with a single deployment
- 🛠️ **Multiple Deployment Options** - GitHub one-click deploy, Vercel one-click deploy, Wrangler CLI, and Dashboard deployment

## 🛠️ Prerequisites

- Cloudflare account
- Telegram account

## 📝 Setup Steps

### 1. Get Your Telegram UID

> [!NOTE]
> You need to know your Telegram user ID (UID), which is a string of numbers used to forward messages to you.

You can get it by:

- Sending any message to [@userinfobot](https://t.me/userinfobot), which will tell you your UID

Note down your numeric ID (e.g., `123456789`).

### 2. Create a Telegram Bot

1. Search for and open [@BotFather](https://t.me/BotFather) in Telegram
2. Send the `/newbot` command
3. Follow the prompts to set your bot's name and username (username must end with `bot`)
4. Upon success, BotFather will send you a Bot API Token (format similar to: `000000000:ABCDEFGhijklmnopqrstuvwxyz`)
5. Securely save this Bot API Token

### 3. Choose a Deployment Method

#### Method 1: GitHub One-Click Deployment (Recommended ⭐)

This is the simplest deployment method, requiring no local development environment.

1. Fork or clone this repository to your GitHub account
2. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/)
3. Navigate to the **Workers & Pages** section
4. Click **Create Application**
5. Select **Connect to Git**
6. Authorize Cloudflare to access your GitHub and select your forked repository
7. Configure deployment settings:
   - **Project name**: Set your project name (e.g., `open-wegram-bot`)
   - **Production branch**: Select your main branch (usually `master`)
   - Keep other settings as default
8. After the first deployment, open the Worker's **Settings** > **Variables and Secrets**:
   - Add `PREFIX` (e.g., `public`)
   - Optionally add the runtime Secret `SECRET_TOKEN` to authenticate Telegram webhook requests, then redeploy
   - **Variables and Secrets** under Workers Builds are build-time settings and are not automatically runtime Worker bindings
9. Click **Save and Deploy** to complete the deployment

You can also add a Secrets Store binding under the Worker's **Settings** > **Bindings**. Set its binding variable name to `SECRET_TOKEN`; the application will resolve the stored value automatically.

The advantage of this method is that when you update your GitHub repository, Cloudflare will automatically redeploy your Worker.

#### Method 2: Vercel One-Click Deployment

Vercel provides another simple deployment option, also supporting automatic deployments from GitHub.

1. Click the "Deploy with Vercel" button below:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fwozulong%2Fopen-wegram-bot&env=SECRET_TOKEN,PREFIX&envDescription=Configure%20your%20bot%20parameters&&project-name=open-wegram-bot&repository-name=open-wegram-bot)

2. Follow Vercel's prompts to complete the deployment process
3. Configure environment variables:
   - `PREFIX`: Set to your desired URL prefix (e.g., `public`)
   - `SECRET_TOKEN`: Optional token used to authenticate Telegram webhook requests
4. After deployment, Vercel will provide a domain like `your-project.vercel.app`

The advantages of Vercel deployment are simplicity, automatic updates, and built-in HTTPS.

#### Method 3: Using Wrangler CLI

If you're comfortable with command-line tools, you can use the Wrangler CLI for deployment.

1. Ensure you have Node.js and npm installed
2. Clone this repository:
   ```bash
   git clone https://github.com/wozulong/open-wegram-bot.git
   cd open-wegram-bot
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Deploy the Worker:
   ```bash
   npx wrangler deploy
   ```
5. Set your Secret Token:
   ```bash
   npx wrangler secret put SECRET_TOKEN
   ```

#### Method 4: Manual Deployment via Cloudflare Dashboard

If you prefer not to use GitHub or command-line tools, you can create the Worker directly in the Cloudflare Dashboard.

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to the **Workers & Pages** section
3. Click **Create Worker**
4. Delete the default code and paste the code from this project's `src/worker.js` and `src/core.js`
5. Click **Save and Deploy**
6. Add environment variables in the Worker settings:
   - `PREFIX` (e.g., `public`)
   - `SECRET_TOKEN` (optional, used to authenticate Telegram webhook requests)

#### Method 5: Deno One-Click Deployment

Deno provides another simple deployment method, which also supports automatic deployment from GitHub repositories.

1. Fork this repository to your GitHub account
2. Log in to [Deno Deploy](https://dash.deno.com) and click **New Project**
3. Select your authorized GitHub account and choose your forked repository
4. Under **Project Configuration** -> **Entrypoint**, select `deno/server.js`
5. Click the **Deploy Project** button and wait for the deployment to complete
6. Click the **Add environment variables** button at the bottom of the page to add environment variables:
   - `PREFIX`: URL prefix, for example `public`
   - `SECRET_TOKEN`: Optional webhook authentication token
7. After clicking the **Save (2 new)** button to save the environment variables, the deployment is complete. The domain name provided by Deno is above the environment variables, such as `project-name.deno.dev`

#### Method 6: Netlify One-Click Deployment

Netlify provides another simple deployment method, which also supports automatic deployment from GitHub repositories.

1. Fork this repository to your GitHub account
2. Log in to [Netlify](https://app.netlify.com/) and click **Add new site** -> **Add new site** -> **Import an existing project**
3. Select your authorized GitHub account and choose your forked repository
4. Fill in the **Site name** and add environment variables:
   - Click **Add environment variables** -> **Add key/value pairs**
   - `NETLIFY_PREFIX`: URL prefix, for example `public`
   - `SECRET_TOKEN`: Optional webhook authentication token
5. Click the **Deploy xxx** button, and after the deployment is complete, you can see the Netlify-provided domain name under the site name, such as `site-name.netlify.app`

#### Method 7: EdgeOne One-Click Deployment

EdgeOne provides another simple deployment method, which also supports automatic deployment from GitHub repositories.

1. Fork this repository to your GitHub account
2. Log in to [EdgeOne Pages](https://edgeone.ai/login?s_url=https://console.tencentcloud.com/edgeone/pages) and click **Create Project** -> **Import Git Repository**
3. Select the authorized GitHub account and choose your forked repository
4. Add environment variables:
- `EDGEONE_PREFIX`: URL prefix, for example `public`
- `SECRET_TOKEN`: Optional webhook authentication token
5. Click the **Start Deployment** button, and after the deployment is complete, go to **Project Settings** -> **Domain Management** to add a custom domain. The default domain `project-name.edgeone.app` only supports preview, and its validity period is only 3 hours!

### 3.1 (Optional) Bind a Custom Domain 🌐

> [!TIP]
> Binding a custom domain to your Worker provides more convenient access!

Cloudflare allows you to bind your own domain to your Worker, enabling you to access the Worker through your domain.

1. In your Cloudflare dashboard, add your domain
2. In the Workers & Pages section, select your worker
3. Click on **Triggers** and then **Add Custom Domain**
4. Follow the instructions to bind your domain

After binding, you can use addresses like `https://your-domain.com/YOUR_PREFIX/install/...` to register/uninstall bots.

### 4. Register Your Telegram Bot

After deploying the Worker, you'll get a URL like:
- GitHub integration: `https://your-project-name.username.workers.dev`
- Vercel deployment: `https://your-project.vercel.app`
- Wrangler/Dashboard: `https://your-worker-name.your-subdomain.workers.dev`
- Deno deployment: `https://project-name.deno.dev`
- Netlify deployment: `https://site-name.netlify.app`
- EdgeOne deployment: `https://your.custom.domain`

Now you need to register your Bot:

1. Visit the following URL in your browser to register your Bot (replace the parameters accordingly):

```
https://your-worker-url/YOUR_PREFIX/install/YOUR_TELEGRAM_UID/BOT_API_TOKEN
```

For example:
```
https://open-wegram-bot.username.workers.dev/public/install/123456789/000000000:ABCDEFGhijklmnopqrstuvwxyz
```

2. If you see a success message, your Bot has been successfully registered

> [!NOTE]
> One Worker instance can register multiple different Bots! Just repeat the above registration steps using different Bot API Tokens.

## 📱 How to Use

### Receiving Messages 📩

Once set up, any messages sent to your Bot will be forwarded to your Telegram account, with sender information displayed below the message.

### Replying to Messages 📤

To reply to a user's message:
1. Find the forwarded message you want to reply to in Telegram
2. Reply directly to that message (using Telegram's reply function)
3. Your reply will be automatically sent to the original sender

### Uninstalling the Bot ❌

If you want to uninstall the Bot, visit the following URL (replace with your parameters):

```
https://your-worker-url/YOUR_PREFIX/uninstall/BOT_API_TOKEN
```

## 🔒 Security Notes

> [!IMPORTANT]
> Please keep your Bot API Token and Secret Token secure, as they are crucial to your service's security.

> [!WARNING]
> **Do not change your Secret Token once it's set!** After changing, all registered bots will stop working properly as they cannot match the original token. If you need to change it, all bots will need to be re-registered.

- Choose a secure and memorable Secret Token during initial setup
- Avoid using simple or common prefix names
- Do not share sensitive information with others

## ⚠️ Usage Limitations

> [!NOTE]
> Cloudflare Worker's free plan has a limit of 100,000 requests per day.

For a personal private chat bot, this limit is usually generous enough. Even if you register multiple bots, you're unlikely to reach this limit unless your bots are extremely active.

If you anticipate higher usage, consider upgrading to Cloudflare's paid plan.

## 🔍 Troubleshooting

- **Messages not forwarded**: Ensure the Bot is correctly registered and check the Worker logs
- **Cannot access registration URL**: Try using a custom domain to solve access issues
- **Reply message fails**: Check if you're correctly using Telegram's reply function
- **Registration fails**: Check the error returned by Telegram and verify the bot token and webhook URL
- **GitHub deployment fails**: Check if your environment variables are correctly set and repository permissions are correct
- **Worker deployment fails**: Check your Wrangler configuration and ensure you're logged in to Cloudflare

## 🤝 Contributions and Contact

If you have any questions, suggestions, or want to contribute code, please submit an Issue/PR or contact me at:

- [LINUX DO](https://linux.do)

## 📄 License

- GPL v3, hoping you'll improve and continue to open source rather than rebranding and closing the source. Thank you.

---

Hope this tool makes your Telegram private messaging experience more convenient! 🎉 If you just want to use it directly, please visit [@WegramBot](https://t.me/wegram_bot)
