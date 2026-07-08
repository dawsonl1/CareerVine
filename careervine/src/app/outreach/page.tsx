"use client";

/**
 * Outreach flow (plan 25): step through target companies one at a time,
 * scan the contactable people at each, open one in a popup, and jump
 * straight into the composer addressed to them.
 */

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { useCompose } from "@/components/compose-email-context";
import { PersonModal } from "@/components/companies/person-modal";
import { getCompanies, getCompanyDetail, type CompanyDetail, type CompanyPerson, type CompanySummary } from "@/lib/company-queries";
import { buildOutreachQueue } from "@/lib/outreach-queue";
import { STAGE_LABELS, type OutreachStage } from "@/lib/stage-derivation";
import {
  ArrowLeft, ArrowRight, ExternalLink, GraduationCap, Mail, MapPin,
  AlertTriangle, ChevronDown, ChevronRight, CalendarClock,
} from "lucide-react";

const PERSONA_LABELS: Record<string, string> = {
  alum_product: "Alum · Product",
  alum_other: "Alum",
  product_peer: "Product peer",
  product_leader: "Product leader",
  recruiter: "Recruiter",
};

const STAGE_STYLES: Record<OutreachStage, string> = {
  not_contacted: "bg-surface-container-high text-on-surface-variant",
  contacted: "bg-primary-container text-on-primary-container",
  bounced: "bg-error-container text-on-error-container",
  replied: "bg-tertiary-container text-on-tertiary-container",
  call_scheduled: "bg-secondary-container text-on-secondary-container",
  call_done: "bg-secondary-container text-on-secondary-container",
  referral: "bg-tertiary-container text-on-tertiary-container",
};

export default function OutreachPage() {
  return (
    <Suspense>
      <OutreachFlow />
    </Suspense>
  );
}

function OutreachFlow() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { openCompose, isOpen: composeOpen } = useCompose();

  const [queue, setQueue] = useState<CompanySummary[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [queueLoading, setQueueLoading] = useState(true);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [popupPerson, setPopupPerson] = useState<CompanyPerson | null>(null);
  const [formerOpen, setFormerOpen] = useState(false);

  // ── Queue ──
  useEffect(() => {
    if (!user) return;
    getCompanies(user.id, { targetsOnly: true, sort: "priority" })
      .then((summaries) => {
        const { queue: q, skippedCount: skipped } = buildOutreachQueue(summaries, new Date().toISOString());
        setQueue(q);
        setSkippedCount(skipped);
      })
      .finally(() => setQueueLoading(false));
  }, [user]);

  // Current position: ?company=<id> when valid, else the front of the queue
  const companyParam = Number(searchParams.get("company"));
  const index = useMemo(() => {
    const i = queue.findIndex((c) => c.id === companyParam);
    return i >= 0 ? i : 0;
  }, [queue, companyParam]);
  const company = queue[index] ?? null;

  const goTo = useCallback(
    (i: number) => {
      const target = queue[i];
      if (!target) return;
      router.replace(`/outreach?company=${target.id}`);
    },
    [queue, router],
  );

  // ── Company detail ──
  const loadDetail = useCallback(async () => {
    if (!user || !company) return;
    setDetailLoading(true);
    try {
      setDetail(await getCompanyDetail(user.id, company.id));
    } finally {
      setDetailLoading(false);
    }
  }, [user, company]);

  useEffect(() => {
    setFormerOpen(false);
    loadDetail();
  }, [loadDetail]);

  // Refresh people (stage chips) after the composer closes
  const [wasComposing, setWasComposing] = useState(false);
  useEffect(() => {
    if (composeOpen) setWasComposing(true);
    else if (wasComposing) {
      setWasComposing(false);
      loadDetail();
    }
  }, [composeOpen, wasComposing, loadDetail]);

  // ── Keyboard: ←/→ steps companies (unless a modal is open) ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (popupPerson || composeOpen) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "ArrowLeft" && index > 0) goTo(index - 1);
      if (e.key === "ArrowRight" && index < queue.length - 1) goTo(index + 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [popupPerson, composeOpen, index, queue.length, goTo]);

  const handleWriteEmail = (person: CompanyPerson) => {
    setPopupPerson(null);
    if (person.email) {
      openCompose({ to: person.email.address, name: person.name, contactId: person.contact_id });
    }
  };

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* ── Queue header ── */}
        <div className="flex items-center justify-between gap-3 mb-6">
          <Link href="/companies" className="text-sm text-on-surface-variant hover:text-on-surface inline-flex items-center gap-1.5">
            <ArrowLeft className="w-4 h-4" /> Companies
          </Link>
          {queue.length > 0 && (
            <div className="flex items-center gap-2">
              <Button variant="tonal" size="sm" disabled={index === 0} onClick={() => goTo(index - 1)} title="Previous company (←)">
                <ArrowLeft className="w-4 h-4" />
              </Button>
              <span className="text-sm text-on-surface-variant whitespace-nowrap">
                Company {index + 1} of {queue.length}
              </span>
              <Select
                value={String(company?.id ?? "")}
                onChange={(v) => {
                  const i = queue.findIndex((c) => String(c.id) === v);
                  if (i >= 0) goTo(i);
                }}
                options={queue.map((c) => ({ value: String(c.id), label: c.name }))}
                className="!h-9 text-xs max-w-44"
              />
              <Button variant="tonal" size="sm" disabled={index >= queue.length - 1} onClick={() => goTo(index + 1)} title="Next company (→)">
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>

        {queueLoading ? (
          <p className="text-sm text-on-surface-variant text-center py-16">Building your outreach queue…</p>
        ) : queue.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-sm text-on-surface-variant">
              No target companies with contactable people yet — run the pipeline import, then come back.
            </CardContent>
          </Card>
        ) : company ? (
          <>
            {/* ── Company context strip ── */}
            <Card className="mb-6">
              <CardContent className="py-4 px-5">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-surface-container-high flex items-center justify-center overflow-hidden shrink-0">
                    {company.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={company.logo_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-lg font-semibold text-on-surface-variant">{company.name.charAt(0)}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h1 className="text-xl font-semibold text-on-surface">{company.name}</h1>
                      {company.target?.priority_score != null && (
                        <span className="text-xs text-on-surface-variant">priority {company.target.priority_score}</span>
                      )}
                      {company.target?.program_name && (
                        <span className="px-2.5 py-0.5 rounded-full text-xs bg-surface-container-high text-on-surface-variant">
                          {company.target.program_name}
                        </span>
                      )}
                      {company.target?.next_app_date ? (
                        <span className="text-xs text-primary font-medium flex items-center gap-1">
                          <CalendarClock className="w-3.5 h-3.5" />
                          Apps: {new Date(`${company.target.next_app_date}T00:00:00`).toLocaleDateString()}
                        </span>
                      ) : company.target?.app_window_text ? (
                        <span className="text-xs italic text-on-surface-variant truncate max-w-72" title={company.target.app_window_text}>
                          {company.target.app_window_text}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-on-surface-variant flex-wrap">
                      <Link href={`/companies/${company.id}`} className="hover:text-primary inline-flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" /> Full company page
                      </Link>
                      {company.bench_count > 0 && (
                        <Link href={`/companies/${company.id}`} className="hover:text-primary">
                          + {company.bench_count} on the bench ↗
                        </Link>
                      )}
                    </div>
                    {detail?.target?.notes?.[0] && (
                      <p className="text-xs text-on-surface-variant mt-1.5 truncate" title={detail.target.notes[0].note}>
                        <span className="font-medium">Latest intel:</span> {detail.target.notes[0].note}
                        {detail.target.notes.length > 1 && <span className="opacity-70"> ({detail.target.notes.length} notes)</span>}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ── People ── */}
            {detailLoading && !detail ? (
              <p className="text-sm text-on-surface-variant text-center py-10">Loading people…</p>
            ) : detail ? (
              <>
                <PersonCards
                  title={`Current employees (${detail.current.length})`}
                  people={detail.current}
                  onSelect={setPopupPerson}
                />
                {detail.former.length > 0 && (
                  <div className="mt-5">
                    <button
                      onClick={() => setFormerOpen((v) => !v)}
                      className="flex items-center gap-1.5 text-sm font-medium text-on-surface-variant hover:text-on-surface py-1.5"
                    >
                      {formerOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      Former employees ({detail.former.length})
                    </button>
                    {formerOpen && <PersonCards title="" people={detail.former} onSelect={setPopupPerson} />}
                  </div>
                )}
                {detail.current.length === 0 && detail.former.length === 0 && (
                  <Card>
                    <CardContent className="py-10 text-center text-sm text-on-surface-variant">
                      Nobody contactable here yet.
                    </CardContent>
                  </Card>
                )}
              </>
            ) : null}

            {skippedCount > 0 && (
              <p className="text-xs text-on-surface-variant mt-8 text-center">
                {skippedCount} more target {skippedCount === 1 ? "company has" : "companies have"} only bench people or nobody —{" "}
                <Link href="/companies" className="underline underline-offset-2 hover:text-on-surface">review them on Companies</Link>.
              </p>
            )}
          </>
        ) : null}
      </main>

      {popupPerson && company && (
        <PersonModal
          person={popupPerson}
          companyId={company.id}
          companyName={company.name}
          userId={user.id}
          onClose={() => setPopupPerson(null)}
          onWriteEmail={handleWriteEmail}
          onChanged={loadDetail}
        />
      )}
    </div>
  );
}

// ── Person cards ───────────────────────────────────────────────────────

function PersonCards({
  title,
  people,
  onSelect,
}: {
  title: string;
  people: CompanyPerson[];
  onSelect: (p: CompanyPerson) => void;
}) {
  if (people.length === 0 && title) {
    return null;
  }
  return (
    <div>
      {title && <h2 className="text-sm font-semibold text-on-surface mb-2.5">{title}</h2>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {people.map((p) => (
          <button
            key={p.contact_id}
            onClick={() => onSelect(p)}
            className="text-left rounded-2xl bg-surface-container hover:bg-surface-container-high transition-colors p-4 focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <div className="flex items-center gap-3">
              <ContactAvatar name={p.name} photoUrl={p.photo_url} className="w-10 h-10 text-sm" />
              <div className="min-w-0">
                <p className="font-medium text-on-surface truncate">{p.name}</p>
                <p className="text-xs text-on-surface-variant truncate">{p.roles[0]?.title ?? p.headline ?? ""}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
              {p.persona && (
                <span className="px-2 py-0.5 rounded-full text-[10px] bg-surface-container-highest text-on-surface-variant">
                  {PERSONA_LABELS[p.persona] ?? p.persona}
                </span>
              )}
              {p.is_alum && (
                <span className="px-2 py-0.5 rounded-full text-[10px] bg-primary-container text-on-primary-container flex items-center gap-0.5">
                  <GraduationCap className="w-2.5 h-2.5" /> BYU
                </span>
              )}
              {p.stage && p.stage !== "not_contacted" && (
                <span className={`px-2 py-0.5 rounded-full text-[10px] ${STAGE_STYLES[p.stage]}`}>{STAGE_LABELS[p.stage]}</span>
              )}
              {p.adjacency_score != null && (
                <span className="text-[10px] text-on-surface-variant/70 ml-auto">adj {p.adjacency_score}</span>
              )}
            </div>
            {p.review_note && (
              <p className="text-xs text-on-surface-variant mt-2 line-clamp-2">&ldquo;{p.review_note}&rdquo;</p>
            )}
            <div className="flex items-center gap-1.5 mt-2.5 text-[11px]">
              {p.roles[0]?.location_label && (
                <span className="text-on-surface-variant flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> {p.roles[0].location_label}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {p.email ? (
                  p.email.bounced ? (
                    <span className="text-error font-medium">bounced</span>
                  ) : p.email.source === "pattern_guessed" ? (
                    <span className="text-yellow-700 dark:text-yellow-400 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" /> guessed
                    </span>
                  ) : (
                    <span className="text-on-surface-variant flex items-center gap-0.5">
                      <Mail className="w-3 h-3" /> email
                    </span>
                  )
                ) : (
                  <span className="text-on-surface-variant/60">no email</span>
                )}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
