# Inactive Email Manager
**Inactive Email Manager** is a secure, customizable, and automated solution for managing sensitive information that can be triggered to release in the event of unforeseen circumstances.

## Features
- **Trigger-Based Activation**: Release sensitive information only when a specific request is initiated.
- **Timed Confirmation**: Includes a countdown workflow to confirm user inactivity before releasing any information.
- **Serverless Implementation**: Built with Cloudflare Workers for scalability, reliability, and free.

## How It Works
1. **Setup**: The user configures their sensitive data and trusted contacts via a secure interface.
2. **Trigger Request**: A trusted contact sends a specific request (e.g., an email) to initiate the process.
3. **Countdown**: A timer starts, giving the user a chance to cancel the action if they are alive and well.
4. **Release**: If the countdown completes without cancellation, the system securely releases the predefined information to the designated recipients.

## Getting Started
1. [Verify your email address](https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/) and your trusted contacts' email addresses in Cloudflare Email Routing.
2. Create a new Cloudflare Worker.
3. Fork this repository and connect it to your Worker in Settings -> Build -> Git Repository.
4. Create a variable `OWNER_EMAIL` as your email address.  
   Create a secret `SECRET` as a cryptographically secure random string.  
   Create a secret `VAULT_CONTENT` as any secret content you want to send to your trusted contacts.
5. (Optional) Set following environment variables in your Worker
    - `CONTACT_WHITELIST`: A comma-separated list of trusted contacts. If not set, anyone who knows the trigger email can activate the vault.
6. Add a custom address in Email -> Email Routing -> Custom addresses as the trigger email.
7. Send an email to the trigger email address with the subject `invite`. The content of the email should be the trusted contact's email addresses, each on a new line.
