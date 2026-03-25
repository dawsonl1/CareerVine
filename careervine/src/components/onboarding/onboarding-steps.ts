/** Shared constant for the onboarding demo contact email */
export const ONBOARDING_CONTACT_EMAIL = "dawson@careervine.app";

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  page: string;
  highlightTarget?: string;
  primaryAction?: {
    label: string;
    href?: string;
    action?: string;
  };
  secondaryAction?: {
    label: string;
    action: string;
  };
  skippable: boolean;
  advanceOn: "manual" | "automatic";
  expandable?: boolean;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "connect_gmail",
    title: "Connect Your Gmail",
    description:
      "Connect your Gmail account so CareerVine can send emails and track your conversations automatically.",
    page: "/settings",
    primaryAction: {
      label: "Connect Gmail",
      action: "connect_gmail",
    },
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "connect_calendar",
    title: "Connect Your Calendar",
    description:
      "Connect Google Calendar so CareerVine can schedule meetings and sync your networking calls.",
    page: "/settings",
    primaryAction: {
      label: "Connect Calendar",
      action: "connect_calendar",
    },
    skippable: true,
    advanceOn: "automatic",
  },
  {
    id: "install_cv_extension",
    title: "Install the CareerVine Chrome Extension",
    description:
      "The CareerVine Chrome Extension lets you import LinkedIn contacts directly into your network with one click.",
    page: "/settings",
    primaryAction: {
      label: "Install Extension",
      href: "https://chromewebstore.google.com/detail/careervine-linkedin-integ/kckdmkjjfcnjlhilgdgfggpgodlmbacd",
    },
    secondaryAction: {
      label: "I've done this",
      action: "confirm",
    },
    skippable: true,
    advanceOn: "manual",
  },
  {
    id: "install_apollo_extension",
    title: "Install the Apollo Chrome Extension",
    description:
      "Apollo helps you find verified email addresses for your LinkedIn connections so you can reach out directly.",
    page: "/settings",
    primaryAction: {
      label: "Install Apollo",
      href: "https://chromewebstore.google.com/detail/alhgpfoeiimagjlnfekdhkjlkiomcapa?utm_source=item-share-cb",
    },
    secondaryAction: {
      label: "I've done this",
      action: "confirm",
    },
    skippable: true,
    advanceOn: "manual",
  },
  {
    id: "import_linkedin_contact",
    title: "Import a LinkedIn Contact",
    description:
      "Visit a LinkedIn profile and use the CareerVine extension to import your first contact into your network.",
    page: "/contacts",
    primaryAction: {
      label: "Open LinkedIn",
      href: "https://www.linkedin.com",
    },
    secondaryAction: {
      label: "I've done this",
      action: "confirm",
    },
    skippable: true,
    advanceOn: "manual",
  },
  {
    id: "click_intro_button",
    title: "Start a New Intro Email",
    description:
      "Click the highlighted \"Intro\" button on Dawson's card in your action list below.",
    page: "/",
    highlightTarget: "intro-button-dawson",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "compose_send_email",
    title: "Compose and Send Your Email",
    description:
      "Review the AI-drafted email, personalize it, and send it directly from CareerVine.",
    page: "/contacts",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "read_reply",
    title: "Read Their Reply",
    description:
      "When your contact replies, CareerVine automatically logs it. Check your inbox to see their response.",
    page: "/inbox",
    highlightTarget: "nav-inbox",
    primaryAction: {
      label: "Check Your Inbox",
      href: "/inbox",
    },
    skippable: true,
    advanceOn: "automatic",
  },
  {
    id: "click_meeting",
    title: "Click Your Meeting",
    description:
      "You just finished a networking chat! Click on the meeting in your schedule to see its details.",
    page: "/",
    highlightTarget: "onboarding-meeting",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "open_log_conversation",
    title: "Log the Conversation",
    description:
      "Great — now click the log conversation button to record what you discussed.",
    page: "/",
    highlightTarget: "onboarding-log-conversation",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "paste_transcript",
    title: "Paste Your Meeting Transcript",
    description:
      "To save the details of your conversation, paste the transcript below. CareerVine will extract key insights and action items.",
    page: "/",
    skippable: false,
    advanceOn: "automatic",
    expandable: true,
  },
  {
    id: "extract_actions",
    title: "Extract Action Items",
    description:
      "CareerVine analyzes your transcript and surfaces the key follow-ups you committed to. Review and confirm them.",
    page: "/",
    highlightTarget: "extract-actions-button",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "view_dashboard_actions",
    title: "See Your Action Items on the Dashboard",
    description:
      "Your follow-ups now live on the dashboard so nothing slips through the cracks. This is your networking command center.",
    page: "/",
    highlightTarget: "nav-home",
    primaryAction: {
      label: "Go to Dashboard",
      href: "/",
    },
    skippable: false,
    advanceOn: "manual",
  },
  {
    id: "wispr_recommendation",
    title: "Supercharge Your Workflow with Wispr Flow",
    description:
      "Dictate emails and notes hands-free with Wispr Flow — the AI voice dictation tool that works everywhere CareerVine does.",
    page: "/",
    primaryAction: {
      label: "Try Wispr Flow",
      href: "https://wisprflow.ai/r?DAWSON59",
    },
    secondaryAction: {
      label: "Skip for now",
      action: "skip_wispr",
    },
    skippable: true,
    advanceOn: "manual",
  },
];

export function getStepIndex(stepId: string): number {
  return ONBOARDING_STEPS.findIndex((s) => s.id === stepId);
}

export function getStepById(stepId: string): OnboardingStep | undefined {
  return ONBOARDING_STEPS.find((s) => s.id === stepId);
}

export function getNextStep(currentStepId: string): OnboardingStep | undefined {
  const index = getStepIndex(currentStepId);
  if (index === -1 || index >= ONBOARDING_STEPS.length - 1) return undefined;
  return ONBOARDING_STEPS[index + 1];
}

export function getProgress(currentStepId: string): number {
  if (currentStepId === "complete") return 100;
  const index = getStepIndex(currentStepId);
  if (index === -1) return 0;
  return Math.round(((index + 1) / ONBOARDING_STEPS.length) * 100);
}
