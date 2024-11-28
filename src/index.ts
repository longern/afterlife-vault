import { EmailMessage } from "cloudflare:email";
import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import { createMimeMessage } from "mimetext/browser";
import PostalMime from "postal-mime";

const DEFAULT_NOT_BEFORE_DAYS = 7;

function decodeHex(str: string) {
  const uint8array = new Uint8Array(Math.ceil(str.length / 2));
  for (let i = 0; i < str.length; )
    uint8array[i / 2] = Number.parseInt(str.slice(i, (i += 2)), 16);
  return uint8array;
}

const NOTIFY_TEMPLATE = `
{{identity}}

Your Inactive Email Manager instance received a token request from this email address.
This means this contact believes you are no longer able to handle this email.
If this is not the case, please immediately stop the following workflow to invalidate
the request:

{{workflowId}}

Otherwise, this token will be valid in {{notBefore}} days
and the contact will be able to access the SECRET you have stored in your instance.

Inactive Email Manager
`;

export class SleepWorkflow extends WorkflowEntrypoint {
  async run(event: WorkflowEvent, step: WorkflowStep) {
    await step.do(
      "notify",
      {
        retries: {
          limit: 2,
          delay: 180000,
          backoff: "exponential",
        },
      },
      async () => {
        const { id, identity, domain } = event.payload;
        const env = this.env;
        const sender = env.SENDER_EMAIL || `noreply@${domain}`;
        const ownerEmail = env.OWNER_EMAIL;

        const notBeforeDays =
          parseDays(env.NOT_BEFORE_DAYS) || DEFAULT_NOT_BEFORE_DAYS;

        const mime = createMimeMessage();
        mime.setSender({ name: "Inactive Email Manager", addr: sender });
        mime.setRecipient(ownerEmail);
        mime.setSubject("Inactive Email Manager Token Request Notification");
        const body = NOTIFY_TEMPLATE.replace("{{workflowId}}", id)
          .replace("{{identity}}", identity)
          .replace("{{notBefore}}", notBeforeDays.toString());
        mime.addMessage({ contentType: "text/plain", data: body });

        const message = new EmailMessage(sender, ownerEmail, mime.asRaw());

        await env.SEB.send(message);
      }
    );

    await step.sleep(
      "sleep",
      (parseDays(this.env.NOT_BEFORE_DAYS) || DEFAULT_NOT_BEFORE_DAYS) *
        (24 * 60 * 60 * 1000)
    );

    try {
      await step.do(
        "send",
        {
          retries: {
            limit: 2,
            delay: 180000,
            backoff: "exponential",
          },
        },
        async () => {
          const { identity, domain } = event.payload;
          const env = this.env;

          const msg = createMimeMessage();
          const sender = env.SENDER_EMAIL || `noreply@${domain}`;
          msg.setSender({ name: "Inactive Email Manager", addr: sender });
          msg.setRecipient(identity);
          msg.setSubject("Secret Message from Your Contact");

          msg.addMessage({
            contentType: "text/plain",
            data:
              `Here is the secret message you requested:\n\n` +
              env.VAULT_CONTENT,
          });

          const emailMessage = new EmailMessage(sender, identity, msg.asRaw());

          await env.SEB.send(emailMessage);
        }
      );
    } catch (e: any) {
      console.error((e as Error).message);
    }
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
        usage: "invitation",
      })
    )
  );

  var hex = Array.prototype.map
    .call(new Uint8Array(signature), (x: number) =>
      x.toString(16).padStart(2, "0")
    )
    .join("");
  const invitation = INVITATION_TEMPLATE.replaceAll("{{contact}}", contact)
    .replaceAll("{{owner}}", owner)
    .replace(
      "{{link}}",
      `mailto:${bot}?subject=Data%20Access%20Request&body=iem-${hex}`
    );
  msg.addMessage({ contentType: "text/plain", data: invitation });
  const emailMessage = new EmailMessage(bot, contact, msg.asRaw());
  await env.SEB.send(emailMessage);
}

function parseDays(daysStr: string) {
  const days = parseFloat(daysStr);
  if (isNaN(days)) return 0;
  if (days > 365) return 0;
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

    msg.setSubject(`Re: ${email.subject}`);
    msg.addMessage({
      contentType: "text/plain",
      data: `We've tried to send out the invitation emails to the contacts you provided.\nEmail status:\n${resultsReport}\nInactive Email Manager`,
    });
  } else return;

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

const SCEDULED_TEMPLATE = `
Your request has been received. However, to confirm that {{owner}}'s email is no longer
in use, we have sent a confirmation email to him. If he does not respond within
{{notBefore}} days, we will send you an email containing a secret message he left.
A new workflow has been created for this request. You can check the status with this ID:
{{workflowId}}
We understand your urgency, but please be patient.

Inactive Email Manager
`;

async function handleContactEmail(message, env) {
  const email = await PostalMime.parse(message.raw);
  if (email.inReplyTo) return; // Can't reply to a reply

  const msg = createMimeMessage();
  msg.setHeader("In-Reply-To", message.headers.get("Message-ID"));
  msg.setSender({ name: "Inactive Email Manager", addr: message.to });
  msg.setRecipient(message.from);
  msg.setSubject(`Re: ${email.subject}`);

  const tokenMatch = email.text?.match(/iem-([0-9a-f]{12,})/);
  if (!tokenMatch) return console.error("No token found in the email body");
  const token = tokenMatch[1];

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.SECRET),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign", "verify"]
  );
  const dataToSign = JSON.stringify({
    contact: message.from,
    owner: env.OWNER_EMAIL,
    usage: "invitation",
  });

  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeHex(token),
    enc.encode(dataToSign)
  );
  if (!verified) return console.error("Invalid token signature");

  const domain = message.to.split("@")[1];
  const workflowId = crypto.randomUUID();
  await env.SLEEP.create({
    id: workflowId,
    params: { id: workflowId, identity: message.from, domain },
  });
  const content = SCEDULED_TEMPLATE.replace("{{owner}}", env.OWNER_EMAIL)
    .replace("{{workflowId}}", workflowId)
    .replace(
      "{{notBefore}}",
      (parseDays(env.NOT_BEFORE_DAYS) || DEFAULT_NOT_BEFORE_DAYS).toString()
    );
  msg.addMessage({ contentType: "text/plain", data: content });

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

    await handleContactEmail(message, env);
  },
};
