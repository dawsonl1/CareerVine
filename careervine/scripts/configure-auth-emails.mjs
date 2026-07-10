#!/usr/bin/env node
/**
 * Configure CareerVine's Supabase auth emails via the Management API (CAR-52).
 *
 * Keeps the dashboard-side email config reproducible in-repo. Three commands:
 *
 *   node scripts/configure-auth-emails.mjs --show
 *     Print the current template/SMTP-related auth config.
 *
 *   node scripts/configure-auth-emails.mjs --apply
 *     Set the branded confirmation + recovery templates. Their links use the
 *     token_hash form ({{ .SiteURL }}/auth/confirm?token_hash=...), which the
 *     /auth/confirm route verifies server-side — so ONLY apply once a build
 *     containing src/app/auth/confirm/route.ts is deployed (or is about to
 *     be, for a pre-merge E2E test). Also bumps the OTP expiry to 24h so
 *     day-old links still work.
 *
 *   node scripts/configure-auth-emails.mjs --revert
 *     Restore the stock Supabase templates ({{ .ConfirmationURL }} form,
 *     1h expiry). Safe on any deployed build.
 *
 *   node scripts/configure-auth-emails.mjs --smtp
 *     Point Supabase at SendGrid (smtp.sendgrid.net, sender
 *     noreply@careervine.app) and raise the email rate limit. Requires
 *     $SENDGRID_API_KEY. Independent of the template state — safe anytime
 *     once the careervine.app SendGrid domain authentication is valid.
 *
 * Auth: $SUPABASE_ACCESS_TOKEN, or the Supabase CLI's token from the macOS
 * keychain (the CLI must be logged in).
 */

import { execFileSync } from "node:child_process";

const PROJECT_REF = "iycrlwqjetkwaauzxrhd";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`;

// ── Branded templates ────────────────────────────────────────────────
// Email-client-safe: table layout, inline styles, no external assets.
// Palette mirrors globals.css (primary #2d6a30, on-surface #1a1c1a).

const layout = (heading, intro, ctaLabel, ctaHref, footnote) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f7f7;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:16px;border:1px solid #e5e7e5;">
      <tr><td style="padding:36px 40px 28px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <p style="margin:0 0 24px 0;font-size:20px;font-weight:600;color:#2d6a30;letter-spacing:-0.2px;">CareerVine</p>
        <h1 style="margin:0 0 12px 0;font-size:22px;line-height:30px;font-weight:500;color:#1a1c1a;">${heading}</h1>
        <p style="margin:0 0 28px 0;font-size:15px;line-height:23px;color:#5f6368;">${intro}</p>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:24px;background-color:#2d6a30;">
          <a href="${ctaHref}" style="display:inline-block;padding:13px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:24px;">${ctaLabel}</a>
        </td></tr></table>
        <p style="margin:28px 0 0 0;font-size:12px;line-height:18px;color:#9aa0a6;">${footnote}</p>
      </td></tr>
    </table>
    <p style="margin:20px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#9aa0a6;">CareerVine — your network is your biggest asset.</p>
  </td></tr>
</table>`;

const BRANDED = {
  mailer_subjects_confirmation: "Confirm your CareerVine account",
  mailer_templates_confirmation_content: layout(
    "You're one click away",
    "Confirm your email and you'll be signed in to CareerVine automatically — ready to start growing your network.",
    "Confirm my email",
    "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup",
    "This link expires in 24 hours and can only be used once. If you didn't create a CareerVine account, you can safely ignore this email.",
  ),
  mailer_subjects_recovery: "Reset your CareerVine password",
  mailer_templates_recovery_content: layout(
    "Reset your password",
    "Click below to choose a new password for your CareerVine account.",
    "Reset password",
    "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password",
    "This link expires in 24 hours and can only be used once. If you didn't request a password reset, you can safely ignore this email.",
  ),
  mailer_otp_exp: 86400,
};

// Stock Supabase values, captured 2026-07-10 before the first --apply.
const STOCK = {
  mailer_subjects_confirmation: "Confirm Your Signup",
  mailer_templates_confirmation_content:
    '<h2>Confirm your signup</h2>\n\n<p>Follow this link to confirm your user:</p>\n<p><a href="{{ .ConfirmationURL }}">Confirm your mail</a></p>',
  mailer_subjects_recovery: "Reset Your Password",
  mailer_templates_recovery_content:
    '<h2>Reset Password</h2>\n\n<p>Follow this link to reset the password for your user:</p>\n<p><a href="{{ .ConfirmationURL }}">Reset Password</a></p>',
  mailer_otp_exp: 3600,
};

// ── Management API plumbing ──────────────────────────────────────────

function accessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "Supabase CLI", "-w"], {
      encoding: "utf8",
    }).trim();
  } catch {
    console.error("No $SUPABASE_ACCESS_TOKEN and no Supabase CLI keychain token found.");
    process.exit(1);
  }
}

async function request(method, body) {
  const res = await fetch(API, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    console.error(`${method} ${API} → ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

// ── Commands ─────────────────────────────────────────────────────────

const mode = process.argv[2];

if (mode === "--show") {
  const config = await request("GET");
  const keys = Object.keys(config)
    .filter((k) => /smtp|rate_limit_email|otp_exp|site_url|uri_allow/.test(k) || k in BRANDED)
    .sort();
  for (const k of keys) console.log(`${k} = ${JSON.stringify(config[k])}`);
} else if (mode === "--apply" || mode === "--revert") {
  const payload = mode === "--apply" ? BRANDED : STOCK;
  await request("PATCH", payload);
  console.log(`${mode === "--apply" ? "Branded" : "Stock"} templates applied:`);
  for (const k of Object.keys(payload)) console.log(`  ${k}`);
} else if (mode === "--smtp") {
  const pass = process.env.SENDGRID_API_KEY;
  if (!pass) {
    console.error("--smtp requires $SENDGRID_API_KEY");
    process.exit(1);
  }
  await request("PATCH", {
    smtp_host: "smtp.sendgrid.net",
    smtp_port: "587", // the Management API models the port as a string
    smtp_user: "apikey",
    smtp_pass: pass,
    smtp_admin_email: "noreply@careervine.app",
    smtp_sender_name: "CareerVine",
    // Built-in SMTP capped this at 2/hr; SendGrid carries real volume.
    rate_limit_email_sent: 30,
  });
  console.log("Custom SMTP configured: SendGrid, noreply@careervine.app, 30 emails/hr.");
} else {
  console.error("Usage: configure-auth-emails.mjs --show | --apply | --revert | --smtp");
  process.exit(1);
}
