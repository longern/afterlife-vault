import { EmailMessage } from "cloudflare:email";
import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import { createMimeMessage } from "mimetext/browser";
import PostalMime from "postal-mime";

const NOTIFY_TEMPLATE = `
{{identity}}

Your Inactive Email Manager instance received a token request from this email address.
This means this contact believes you are no longer able to handle this email.
If this is not the case, please immediately modify your Inactive Email Manager secret
to invalidate the token. Otherwise, this token will be valid in {{notBefore}} days
and the contact will be able to access the SECRET you have stored in your instance.

Inactive Email Manager
`;

export class SleepWorkflow extends WorkflowEntrypoint {
  async run(event: WorkflowEvent, step: WorkflowStep) {
    await step.do(
      "notify",
      {
        retries: {
          limit: 3,
          delay: 10000,
          backoff: "exponential",
        },
      },
      async () => {
        const { identity, domain } = event.payload;
        const env = this.env;
        const sender = env.SENDER_EMAIL || `noreply@${domain}`;
        const ownerEmail = env.OWNER_EMAIL;

        const notBeforeDays = parseDays(env.NOT_BEFORE_DAYS) || 3;

        const mime = createMimeMessage();
        mime.setSender({ name: "Inactive Email Manager", addr: sender });
        mime.setRecipient(ownerEmail);
        mime.setSubject("Inactive Email Manager Token Request Notification");
        const body = NOTIFY_TEMPLATE.replace("{{identity}}", identity).replace(
          "{{notBefore}}",
          notBeforeDays.toString()
        );
        mime.addMessage({ contentType: "text/plain", data: body });

        const message = new EmailMessage(sender, ownerEmail, mime.asRaw());

        await env.SEB.send(message);
      }
    );

    await step.sleep(
      "sleep",
      (parseDays(this.env.NOT_BEFORE_DAYS) || 3) * 24 * 60 * 60
    );
  }
}

const INVITATION_TEMPLATE = `
To {{contact}},

Your contact {{owner}} has invited you to join Inactive Email Manager.
When you are sure they can no longer handle their email account, you can use the link
at the end of this email to create a message requesting access to their account data.
Note:
Please keep your email account secure to prevent malicious use by others.
Please do not use this service while your contact can still access their email account,
otherwise your account will be banned.

{{link}}

Inactive Email Manager
`;

async function sendInvitationEmail({ bot, owner, contact, env }) {
  const msg = createMimeMessage();
  msg.setSender({ name: "Inactive Email Manager", addr: bot });
  msg.setRecipient(contact);
  msg.setSubject(`Inactive Email Manager Invitation from ${owner}`);
  const enc = new TextEncoder();
  const entropy = crypto.getRandomValues(new Uint8Array(2));
  const salt = Array.prototype.map
    .call(entropy, (x: number) => x.toString(16).padStart(2, "0"))
    .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.SECRET),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign", "verify"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(
      // Keys are in alphabetical order
      JSON.stringify({
        contact,
        owner,
        salt,
        secret: env.SECRET,
        usage: "invitation",
      })
    )
  );

  var hex = Array.prototype.map
    .call(new Uint8Array(signature), (x: number) =>
      x.toString(16).padStart(2, "0")
    )
    .join("")
    .slice(0, 8);
  const invitation = INVITATION_TEMPLATE.replaceAll("{{contact}}", contact)
    .replaceAll("{{owner}}", owner)
    .replace(
      "{{link}}",
      `mailto:${bot}?subject=Data%20Access%20Request%20iem-${salt}${hex}`
    );
  msg.addMessage({ contentType: "text/plain", data: invitation });
  const emailMessage = new EmailMessage(bot, contact, msg.asRaw());
  await env.SEB.send(emailMessage);
}

function parseDays(daysStr: string) {
  const days = parseFloat(daysStr);
  if (isNaN(days)) return 0;
  if (days > 3650) return 0;
  return days;
}

async function handleOwnerEmail(message, env) {
  const email = await PostalMime.parse(message.raw);
  if (email.inReplyTo) return console.error("Cannot reply to a reply");

  const msg = createMimeMessage();
  msg.setHeader("In-Reply-To", message.headers.get("Message-ID"));
  msg.setSender({ name: "Inactive Email Manager", addr: message.to });
  msg.setRecipient(message.from);

  if (email.subject?.match(/(invite|invitation)/i)) {
    // Extract the contact email from the email body
    const contactMatches = email.text?.matchAll(/[\w.-]+@[\w.-]+/g);
    if (!contactMatches) {
      console.error("No contact email found in the email body");
      return;
    }
    const contacts = Array.from(contactMatches, (m) => m[0]);
    const results = await Promise.allSettled(
      contacts.map(async (contact, index) => {
        await new Promise((resolve) => setTimeout(resolve, index * 1000));
        await sendInvitationEmail({
          bot: message.to,
          owner: message.from,
          contact,
          env,
        });
      })
    );
    const resultsReport = results
      .map(
        (r, i) =>
          `${contacts[i]}: ${r.status === "fulfilled" ? "success" : r.reason}\n`
      )
      .join("");

    msg.setSubject("Inactive Email Manager Invitation Report");
    msg.addMessage({
      contentType: "text/plain",
      data: `We've tried to send out the invitation emails to the contacts you provided.\nEmail status:\n${resultsReport}`,
    });
  }

  const replyMessage = new EmailMessage(message.to, message.from, msg.asRaw());

  await env.SEB.send(replyMessage)
    .catch((err: Error) => {
      if (err.message.includes("verified")) {
        msg.addMessage({
          contentType: "text/plain",
          data: "Warning: The email address is not verified. You must verify the email first.",
        });
        const replyMessage = new EmailMessage(
          message.to,
          message.from,
          msg.asRaw()
        );
        return message.reply(replyMessage);
      } else return Promise.reject(err);
    })
    .catch((err: Error) => {
      console.error(err.message);
    });
}

async function handleContactEmail(message, env) {
  const email = await PostalMime.parse(message.raw);
  if (email.inReplyTo) return; // Can't reply to a reply

  const msg = createMimeMessage();
  msg.setHeader("In-Reply-To", message.headers.get("Message-ID"));
  msg.setSender({ name: "Inactive Email Manager", addr: message.to });
  msg.setRecipient(message.from);
  msg.setSubject("Inactive Email Manager Auto-Reply");

  const tokenMatch = email.subject?.match(/iem-([0-9a-f]{12,})/);
  console.log({
    sender: message.from,
    token: tokenMatch ? tokenMatch[1] : email.subject,
  });
  const domain = message.to.split("@")[1];
  const workflowId = crypto.randomUUID();
  const workflow = await env.SLEEP.create({
    id: workflowId,
    params: { identity: message.from, domain },
  });
  msg.addMessage({
    contentType: "text/plain",
    data: `Your request has been received. You will be notified when the token is valid.\nID: ${
      workflow.id
    }\nStatus:${await workflow.status()}`,
  });

  const replyMessage = new EmailMessage(message.to, message.from, msg.asRaw());

  await message.reply(replyMessage).catch((err) => {
    console.error(err.message);
  });
}

export default {
  async email(message, env) {
    if (message.from === env.OWNER_EMAIL) {
      return handleOwnerEmail(message, env);
    }

    if (env.CONTACT_WHITELIST) {
      const whitelist = env.CONTACT_WHITELIST.split(",");
      if (!whitelist.includes(message.from)) return;
    }

    await handleContactEmail(message, env);
  },
};
