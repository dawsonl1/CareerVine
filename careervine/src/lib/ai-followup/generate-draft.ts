/**
 * LLM Call (Final): Generate the actual follow-up email draft.
 *
 * Adjusts tone based on contact context (industry, role, relationship).
 * Produces both the email body (HTML) and subject line.
 */

import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";
import createDOMPurify from "dompurify";
// @ts-expect-error -- jsdom has no bundled types; @types/jsdom is a devDep
import { JSDOM } from "jsdom";
import type { ContactContext } from "./gather-context";
import type { Interest } from "./extract-interests";
import type { ArticleResult } from "./find-article";

// Server-side DOMPurify (Node.js doesn't have window.document)
const jsdomWindow = new JSDOM("").window;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const purify = createDOMPurify(jsdomWindow as any);

export interface DraftResult {
  subject: string;
  bodyHtml: string;
}

function buildDraftPrompt(params: {
  senderFirstName: string;
  contact: ContactContext;
  interest: Interest;
  articleTitle?: string;
  articleUrl?: string;
}): string {
  const { senderFirstName, contact, interest, articleTitle, articleUrl } = params;

  const timeParts: string[] = [];
  if (contact.meetings.length > 0) {
    const lastMeeting = contact.meetings[0]; // already sorted most recent first
    const date = new Date(lastMeeting.date).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    timeParts.push(`Last met: ${lastMeeting.title || lastMeeting.type} in ${date}`);
  }

  const contextLines: string[] = [];
  contextLines.push(`Contact: ${contact.contactName}`);
  if (contact.role) contextLines.push(`Role: ${contact.role}`);
  if (contact.companies.length) contextLines.push(`Work: ${contact.companies[0]}`);
  if (contact.industry) contextLines.push(`Industry: ${contact.industry}`);
  if (contact.schools.length) contextLines.push(`Education: ${contact.schools[0]}`);
  if (timeParts.length) contextLines.push(timeParts[0]);

  const interestLine = `They mentioned: ${interest.topic}\nEvidence: "${interest.evidence}"`;

  let articleLine = "";
  if (articleTitle && articleUrl) {
    articleLine = `\nArticle to share:\n- Title: ${articleTitle}\n- URL: ${articleUrl}`;
  }

  return `Write a brief, warm follow-up email from ${senderFirstName} to ${contact.contactName}.

${contextLines.join("\n")}

${interestLine}${articleLine}

Rules:
- Keep it to 3-5 sentences max
- Infer appropriate formality from their role, industry, and relationship context
- ${articleUrl ? "Reference the article naturally and include the link" : "Reference what they mentioned and ask how it's going"}
- End with a brief personal touch
- Sign off as ${senderFirstName}
- Do NOT be overly enthusiastic or salesy
- Do NOT use phrases like "I stumbled upon" or "I came across" — say "I was reading this" or "saw this and thought of you"
- Output clean HTML (use <p> tags). Do NOT use markdown.
- Do NOT include a subject line in the body — just the email content.`;
}

export async function generateDraft(params: {
  senderFirstName: string;
  senderEmail: string;
  contact: ContactContext;
  interest: Interest;
  article?: ArticleResult["article"];
}): Promise<DraftResult> {
  const { senderFirstName, contact, interest, article } = params;

  const openai = getOpenAIClient();
  const model = DEFAULT_MODEL;

  // Generate email body
  const bodyResponse = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are an expert email writer helping a professional reconnect with contacts. Write natural, concise emails that feel genuine — not templated.",
      },
      {
        role: "user",
        content: buildDraftPrompt({
          senderFirstName,
          contact,
          interest,
          articleTitle: article?.title,
          articleUrl: article?.url,
        }),
      },
    ],
    max_tokens: 1000,
  });

  let bodyHtml = bodyResponse.choices[0]?.message?.content || "";

  // Sanitize the HTML to prevent XSS
  bodyHtml = purify.sanitize(bodyHtml, {
    ALLOWED_TAGS: ["p", "br", "a", "strong", "em", "b", "i"],
    ALLOWED_ATTR: ["href", "target", "rel"],
  });

  // Generate subject line
  const subjectResponse = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "Generate a concise, natural email subject line. Return ONLY the subject line text, nothing else. No quotes. Keep it casual and short (under 50 chars).",
      },
      { role: "user", content: bodyHtml },
    ],
    max_tokens: 50,
  });

  const subject = subjectResponse.choices[0]?.message?.content?.trim() || "Thinking of you";

  return { subject, bodyHtml };
}
