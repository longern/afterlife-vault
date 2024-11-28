import { decode, sign, verify } from "@tsndr/cloudflare-worker-jwt";
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext/browser";
import PostalMime from "postal-mime";

const INDEX_HTML = `
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <title>Afterlife Vault</title>
  </head>
  <body>
    <h1>Welcome to the Afterlife Vault</h1>
    <button id="create">Request Token</button>
    <div id="token-url"></div>
    <script>
      document.getElementById("create").addEventListener("click", async () => {
        const response = await fetch("/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const { token, error } = await response.json();
        if (error) return alert(error);
        const tokenUrl = new URL(window.location);
        tokenUrl.search = new URLSearchParams({ t }).toString();
        document.getElementById("token-url").innerText = tokenUrl;
      });
    </script>
  </body>
</html>
`;

const NOTIFY_TEMPLATE = `
{{identity}}

Your Afterlife Vault instance received a token request from this email address.
This means this contact believes you are no longer able to handle this email.
If this is not the case, please immediately modify your Afterlife Vault secret
to invalidate the token. Otherwise, this token will be valid in {{notBefore}} days
and the contact will be able to access the SECRET you have stored in your instance.

Afterlife Vault
`;

function parseDays(daysStr) {
  const days = parseFloat(daysStr);
  if (isNaN(days)) return 0;
  if (days > 3650) return 0;
  return days;
}

async function createToken(identity, domain, env) {
  // Send a notification email to the owner
  const sender = env.SENDER_EMAIL || `noreply@${domain}`;
  const ownerEmail = env.OWNER_EMAIL;

  const notBeforeDays = parseDays(env.NOT_BEFORE_DAYS) || 3;
  const expirationDays = Math.max(
    parseDays(env.EXPIRATION_DAYS) || 7,
    notBeforeDays + 0.03
  );

  const mime = createMimeMessage();
  mime.setSender({ name: "Afterlife Vault", addr: sender });
  mime.setRecipient(ownerEmail);
  mime.setSubject("Afterlife Vault Token Request Notification");
  const body = NOTIFY_TEMPLATE.replace("{{identity}}", identity).replace(
    "{{notBefore}}",
    notBeforeDays
  );
  mime.addMessage({ contentType: "text/plain", data: body });

  const message = new EmailMessage(sender, ownerEmail, mime.asRaw());

  try {
    await env.OWNER.send(message);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  return sign(
    {
      identity,
      nbf: Math.floor(Date.now() / 1000) + notBeforeDays * 24 * 60 * 60,
      exp: Math.floor(Date.now() / 1000) + expirationDays * 24 * 60 * 60,
    },
    env.SECRET
  );
}

export default {
  async email(message, env) {
    if (env.CONTACT_WHITELIST) {
      const whitelist = env.CONTACT_WHITELIST.split(",");
      if (!whitelist.includes(message.from)) return;
    }

    const email = await PostalMime.parse(message.raw);
    if (email.inReplyTo) return; // Can't reply to a reply

    const msg = createMimeMessage();
    msg.setHeader("In-Reply-To", message.headers.get("Message-ID"));
    msg.setSender({ name: "Afterlife Vault", addr: message.to });
    msg.setRecipient(message.from);
    msg.setSubject("Afterlife Vault Auto-Reply");

    const text = (email.text || "").replaceAll("&nbsp;", " ");
    const tokenMatch = text.match(/\[ ([a-zA-Z0-9._-]+) \]/);
    console.log({
      sender: message.from,
      token: tokenMatch ? tokenMatch[1] : text,
    });
    if (!tokenMatch) {
      const domain = message.to.split("@")[1];
      const token = await createToken(message.from, domain, env);
      msg.addMessage({
        contentType: "text/plain",
        data: `[ ${token} ]`,
      });
    } else {
      const token = tokenMatch[1];
      try {
        await verify(token, env.SECRET, { throwError: true });
        msg.addMessage({
          contentType: "text/plain",
          data: env.VAULT_CONTENT,
        });
      } catch (err) {
        if (err.message === "NOT_YET_VALID") {
          const decoded = decode(token);
          const verboseNbf = new Date(decoded.payload.nbf * 1000).toUTCString();
          msg.addMessage({
            contentType: "text/plain",
            data: `Token is not yet valid. It will be valid after ${verboseNbf}`,
          });
        } else if (err.message === "EXPIRED") {
          msg.addMessage({
            contentType: "text/plain",
            data: "Token has expired.",
          });
        } else {
          msg.addMessage({
            contentType: "text/plain",
            data: "Invalid token.",
          });
        }
      }
    }

    const replyMessage = new EmailMessage(
      message.to,
      message.from,
      msg.asRaw()
    );

    await message.reply(replyMessage);
  },

  async fetch(request, env) {
    if (request.headers.get("Content-Type") !== "application/json") {
      return new Response(INDEX_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    const domain = new URL(request.url).hostname;
    const token = await createToken("anonymous", domain, env);

    return Response.json({ token });
  },
};
