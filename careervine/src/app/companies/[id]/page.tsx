"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { useCompose } from "@/components/compose-email-context";
import {
  getCompanyDetail,
  promoteContactToProspect,
  deleteCompanyOffice,
  addTargetCompany,
  updateTargetCompany,
  addTargetCompanyNote,
  deleteTargetCompanyNote,
  type CompanyDetail,
  type CompanyPerson,
} from "@/lib/company-queries";
import { STAGE_LABELS, type OutreachStage } from "@/lib/stage-derivation";
import {
  ArrowLeft, ExternalLink, Globe, Target, ChevronDown, ChevronRight,
  MapPin, X, Plus, AlertTriangle, Mail, GraduationCap, Trash2, StickyNote,
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

const STATUS_OPTIONS = ["researching", "outreach_active", "applied", "interviewing", "closed"] as const;
const STATUS_LABELS: Record<string, string> = {
  researching: "Researching",
  outreach_active: "Outreach active",
  applied: "Applied",
  interviewing: "Interviewing",
  closed: "Closed",
};

function staleness(lastScrapedAt: string | null): string | null {
  if (!lastScrapedAt) return null;
  return `Data as of ${new Date(lastScrapedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const companyId = Number(id);
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { success: toastSuccess, error: toastError } = useToast();
  const { openCompose, gmailConnected } = useCompose();

  const locationKey = searchParams.get("location") ?? undefined;
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [benchOpen, setBenchOpen] = useState(false);
  const [showAllFacets, setShowAllFacets] = useState(false);
  const [manageOffices, setManageOffices] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteLocationId, setNoteLocationId] = useState<string>("");
  const [editingAppDate, setEditingAppDate] = useState(false);
  const [appDateDraft, setAppDateDraft] = useState("");

  const load = useCallback(async () => {
    if (!user || Number.isNaN(companyId)) return;
    setLoading(true);
    try {
      const data = await getCompanyDetail(user.id, companyId, { locationKey });
      setDetail(data);
    } catch {
      toastError("Failed to load company");
    } finally {
      setLoading(false);
    }
  }, [user, companyId, locationKey, toastError]);

  useEffect(() => {
    load();
  }, [load]);

  const setLocationFilter = (key: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (key) params.set("location", key);
    else params.delete("location");
    router.replace(`/companies/${companyId}${params.size ? `?${params}` : ""}`);
  };

  if (!user) return null;
  if (loading && !detail) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center text-sm text-on-surface-variant">Loading…</main>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center text-sm text-on-surface-variant">Company not found.</main>
      </div>
    );
  }

  const { company, target, offices, facets, current, former, bench } = detail;
  const visibleFacets = showAllFacets ? facets : facets.slice(0, 8);
  const contactCount = new Set([...current, ...former].map((p) => p.contact_id)).size;

  const handlePromote = async (person: CompanyPerson) => {
    try {
      await promoteContactToProspect(person.contact_id);
      toastSuccess(`${person.name} added to outreach`);
      load();
    } catch {
      toastError("Failed to promote");
    }
  };

  const handleAddTarget = async () => {
    try {
      await addTargetCompany(user.id, companyId);
      load();
    } catch {
      toastError("Failed to add target");
    }
  };

  const saveAppDate = async () => {
    if (!target) return;
    try {
      await updateTargetCompany(target.id, { next_app_date: appDateDraft || null });
      setEditingAppDate(false);
      load();
    } catch {
      toastError("Failed to save date");
    }
  };

  const addNote = async () => {
    if (!target || !noteText.trim()) return;
    try {
      await addTargetCompanyNote(target.id, noteText.trim(), noteLocationId ? Number(noteLocationId) : null);
      setNoteText("");
      setNoteLocationId("");
      load();
    } catch {
      toastError("Failed to add note");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/companies" className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-4">
          <ArrowLeft className="w-4 h-4" /> Companies
        </Link>

        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-14 h-14 rounded-2xl bg-surface-container-high flex items-center justify-center overflow-hidden shrink-0">
              {company.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={company.logo_url} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-xl font-semibold text-on-surface-variant">{company.name.charAt(0)}</span>
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-on-surface truncate">{company.name}</h1>
              <div className="flex items-center gap-3 mt-1 text-sm text-on-surface-variant flex-wrap">
                <span>
                  {contactCount} contact{contactCount === 1 ? "" : "s"}
                  {bench.length > 0 && <span className="opacity-70"> · {bench.length} bench</span>}
                </span>
                {company.linkedin_url && (
                  <a href={company.linkedin_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-primary">
                    <ExternalLink className="w-3.5 h-3.5" /> LinkedIn
                  </a>
                )}
                {company.domain && (
                  <a href={`https://${company.domain}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-primary">
                    <Globe className="w-3.5 h-3.5" /> {company.domain}
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Target controls */}
          <div className="flex items-center gap-3">
            {target ? (
              <>
                <Select
                  value={target.status}
                  onChange={async (v) => {
                    await updateTargetCompany(target.id, { status: v });
                    load();
                  }}
                  options={STATUS_OPTIONS.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
                  className="!h-10 text-sm"
                />
                {editingAppDate ? (
                  <span className="flex items-center gap-1.5">
                    <input
                      type="date"
                      value={appDateDraft}
                      onChange={(e) => setAppDateDraft(e.target.value)}
                      className="h-10 px-3 rounded-lg bg-surface-container-high text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <Button size="sm" onClick={saveAppDate}>Save</Button>
                    <Button size="sm" variant="text" onClick={() => setEditingAppDate(false)}>Cancel</Button>
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setAppDateDraft(target.next_app_date ?? "");
                      setEditingAppDate(true);
                    }}
                    className="h-10 px-3.5 rounded-lg bg-surface-container-high text-sm text-on-surface-variant hover:text-on-surface transition-colors"
                    title={target.app_window_text ?? "Set the real application date when you learn it"}
                  >
                    {target.next_app_date
                      ? `Apps: ${new Date(`${target.next_app_date}T00:00:00`).toLocaleDateString()}`
                      : "Set app date"}
                  </button>
                )}
              </>
            ) : (
              <Button variant="tonal" onClick={handleAddTarget}>
                <Target className="w-4 h-4 mr-1.5" /> Add to targets
              </Button>
            )}
          </div>
        </div>

        {/* App-window hint (display-only research hint, never sorted) */}
        {target?.app_window_text && (
          <p className="text-xs italic text-on-surface-variant -mt-3 mb-5">Window hint: {target.app_window_text}</p>
        )}

        {/* ── Location facets ── */}
        {facets.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mb-6">
            <button
              onClick={() => setLocationFilter(null)}
              className={`px-3.5 py-1.5 rounded-full text-sm transition-colors ${
                !locationKey ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
              }`}
            >
              All
            </button>
            {visibleFacets.map((f) => (
              <button
                key={f.key}
                onClick={() => setLocationFilter(locationKey === f.key ? null : f.key)}
                className={`px-3.5 py-1.5 rounded-full text-sm transition-colors flex items-center gap-1.5 ${
                  locationKey === f.key ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
                }`}
              >
                <MapPin className="w-3.5 h-3.5" /> {f.label} ({f.count})
              </button>
            ))}
            {facets.length > 8 && !showAllFacets && (
              <button onClick={() => setShowAllFacets(true)} className="px-3 py-1.5 text-sm text-primary">
                +{facets.length - 8} more
              </button>
            )}
            <button
              onClick={() => setManageOffices((v) => !v)}
              className="ml-auto text-xs text-on-surface-variant hover:text-on-surface underline-offset-2 hover:underline"
            >
              Manage offices
            </button>
          </div>
        )}

        {/* Office management (phantom-office correction) */}
        {manageOffices && (
          <Card className="mb-6">
            <CardContent className="py-4 px-5">
              <p className="text-xs text-on-surface-variant mb-3">
                Deleting an office clears locations that were inferred from it (profile matches). Locations stated on someone&apos;s own experience are kept.
              </p>
              <div className="flex gap-2 flex-wrap">
                {offices.length === 0 && <span className="text-sm text-on-surface-variant">No offices recorded yet.</span>}
                {offices.map((o) => (
                  <span key={o.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-high text-sm text-on-surface">
                    {o.label}
                    {o.source === "manual" && <span className="text-[10px] text-on-surface-variant">(manual)</span>}
                    <button
                      onClick={async () => {
                        try {
                          await deleteCompanyOffice(o, companyId);
                          toastSuccess(`Removed ${o.label} office`);
                          load();
                        } catch {
                          toastError("Failed to remove office");
                        }
                      }}
                      className="text-on-surface-variant hover:text-error"
                      title="Remove this office"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* ── People ── */}
          <div className="lg:col-span-2 space-y-6">
            <PeopleSection title="Current employees" people={current} onCompose={openCompose} gmailConnected={gmailConnected} />
            <PeopleSection title="Former employees" people={former} onCompose={openCompose} gmailConnected={gmailConnected} />

            {/* Bench: dormant data, one collapsed section, never mixed in */}
            {bench.length > 0 && (
              <div>
                <button
                  onClick={() => setBenchOpen((v) => !v)}
                  className="flex items-center gap-1.5 text-sm font-medium text-on-surface-variant hover:text-on-surface py-2"
                >
                  {benchOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  {bench.length} more on the bench
                </button>
                {benchOpen && (
                  <div className="grid gap-1.5 mt-1">
                    {bench.map((p) => (
                      <div key={p.contact_id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors">
                        <ContactAvatar name={p.name} photoUrl={p.photo_url} className="w-8 h-8 text-xs" />
                        <div className="min-w-0 flex-1">
                          <Link href={`/contacts/${p.contact_id}`} className="text-sm font-medium text-on-surface hover:text-primary truncate block">
                            {p.name}
                          </Link>
                          <p className="text-xs text-on-surface-variant truncate">{p.roles[0]?.title ?? p.headline ?? ""}</p>
                        </div>
                        {p.adjacency_score != null && (
                          <span className="text-[10px] text-on-surface-variant shrink-0" title="Pipeline adjacency score">
                            adj {p.adjacency_score}
                          </span>
                        )}
                        <Button size="sm" variant="tonal" onClick={() => handlePromote(p)}>
                          Add to outreach
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Recruiting intel ── */}
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2">
              <StickyNote className="w-4 h-4 text-primary" /> Recruiting notes
            </h2>
            {target ? (
              <>
                <Card>
                  <CardContent className="py-4 px-4 space-y-3">
                    <textarea
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="What did you learn? (timeline, referral process, team intel…)"
                      rows={3}
                      className="w-full rounded-lg bg-surface-container-high p-3 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40 resize-none"
                    />
                    <div className="flex items-center gap-2">
                      <Select
                        value={noteLocationId}
                        onChange={setNoteLocationId}
                        options={[
                          { value: "", label: "Company-wide" },
                          ...offices.map((o) => ({ value: String(o.location_id), label: o.label })),
                        ]}
                        className="!h-9 text-xs flex-1"
                      />
                      <Button size="sm" onClick={addNote} disabled={!noteText.trim()}>
                        <Plus className="w-4 h-4 mr-1" /> Add
                      </Button>
                    </div>
                  </CardContent>
                </Card>
                {target.notes.length === 0 ? (
                  <p className="text-xs text-on-surface-variant px-1">No notes yet — the best moment to add one is right after a call.</p>
                ) : (
                  <div className="space-y-2">
                    {target.notes.map((n) => (
                      <Card key={n.id}>
                        <CardContent className="py-3 px-4">
                          <p className="text-sm text-on-surface whitespace-pre-wrap">{n.note}</p>
                          <div className="flex items-center justify-between mt-2">
                            <span className="text-[11px] text-on-surface-variant">
                              {new Date(n.created_at).toLocaleDateString()}
                              {n.location_label && <> · <MapPin className="w-3 h-3 inline" /> {n.location_label}</>}
                            </span>
                            <button
                              onClick={async () => {
                                await deleteTargetCompanyNote(n.id);
                                load();
                              }}
                              className="text-on-surface-variant hover:text-error"
                              title="Delete note"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-on-surface-variant px-1">Add this company to your targets to log recruiting intel.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

// ── People section ─────────────────────────────────────────────────────

function PeopleSection({
  title,
  people,
  onCompose,
  gmailConnected,
}: {
  title: string;
  people: CompanyPerson[];
  onCompose: (opts?: { to?: string; name?: string; contactId?: number }) => void;
  gmailConnected: boolean;
}) {
  if (people.length === 0) return null;
  return (
    <div>
      <h2 className="text-sm font-semibold text-on-surface mb-2">
        {title} <span className="text-on-surface-variant font-normal">({people.length})</span>
      </h2>
      <div className="grid gap-2">
        {people.map((p) => (
          <Card key={p.contact_id}>
            <CardContent className="py-3.5 px-4">
              <div className="flex items-center gap-3.5">
                <ContactAvatar name={p.name} photoUrl={p.photo_url} className="w-10 h-10 text-sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/contacts/${p.contact_id}`} className="font-medium text-on-surface hover:text-primary truncate">
                      {p.name}
                    </Link>
                    {p.persona && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] bg-surface-container-high text-on-surface-variant">
                        {PERSONA_LABELS[p.persona] ?? p.persona}
                      </span>
                    )}
                    {p.is_alum && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] bg-primary-container text-on-primary-container flex items-center gap-1">
                        <GraduationCap className="w-3 h-3" /> BYU
                      </span>
                    )}
                    {p.stage && (
                      <span className={`px-2 py-0.5 rounded-full text-[11px] ${STAGE_STYLES[p.stage]}`}>{STAGE_LABELS[p.stage]}</span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-variant truncate mt-0.5">
                    {p.roles[0]?.title ?? p.headline ?? ""}
                    {p.roles[0]?.location_label && <> · {p.roles[0].location_label}</>}
                    {p.roles[0]?.workplace_type === "remote" && <> · Remote</>}
                    {p.roles.filter((r) => r.is_current).length > 1 && (
                      <> · +{p.roles.filter((r) => r.is_current).length - 1} more role{p.roles.filter((r) => r.is_current).length > 2 ? "s" : ""}</>
                    )}
                  </p>
                  {staleness(p.last_scraped_at) && (
                    <p className="text-[10px] text-on-surface-variant/70 mt-0.5">{staleness(p.last_scraped_at)}</p>
                  )}
                </div>
                {p.email && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {p.email.source === "pattern_guessed" && !p.email.bounced && (
                      <span title="This address is pattern-guessed — verify before heavy outreach">
                        <AlertTriangle className="w-4 h-4 text-yellow-600" />
                      </span>
                    )}
                    {p.email.bounced && (
                      <span className="text-[11px] text-error font-medium" title="This address bounced">bounced</span>
                    )}
                    {gmailConnected && !p.email.bounced && (
                      <Button
                        size="sm"
                        variant="tonal"
                        onClick={() => onCompose({ to: p.email!.address, name: p.name, contactId: p.contact_id })}
                        title={`Email ${p.email.address}`}
                      >
                        <Mail className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
