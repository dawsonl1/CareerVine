"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

const HOW_MET_CHIPS = [
  { label: "Career fair", value: "Career fair" },
  { label: "LinkedIn", value: "LinkedIn" },
  { label: "Class", value: "Class" },
  { label: "Event", value: "Event" },
  { label: "Mutual friend", value: "Mutual friend" },
];

const COLD_CHIP = { label: "We haven't met", value: "We haven't met" };

const GOAL_CHIPS = [
  { label: "Set up a coffee chat", value: "Set up a coffee chat" },
  { label: "Stay on their radar", value: "Stay on their radar" },
  { label: "Ask about a role", value: "Ask about a role" },
  { label: "Get an introduction", value: "Get an introduction to someone" },
  { label: "Learn about their work", value: "Learn about their work" },
  { label: "Thank them", value: "Thank them" },
];

interface IntroContextFormProps {
  contactName: string;
  initialMetThrough?: string;
  initialGoal?: string;
  onGenerate: (context: { howMet: string; goal: string; notes: string }) => void;
  onSkip: () => void;
  generating: boolean;
  error?: string | null;
}

export function IntroContextForm({
  contactName,
  initialMetThrough,
  initialGoal,
  onGenerate,
  onSkip,
  generating,
  error,
}: IntroContextFormProps) {
  const [howMet, setHowMet] = useState(initialMetThrough || "");
  const [selectedHowMetChip, setSelectedHowMetChip] = useState<string | null>(
    // Pre-select chip if initial value matches
    initialMetThrough
      ? [...HOW_MET_CHIPS, COLD_CHIP].find(
          (c) => c.value.toLowerCase() === initialMetThrough.toLowerCase()
        )?.value || null
      : null
  );
  const [goal, setGoal] = useState(initialGoal || "");
  const [selectedGoalChip, setSelectedGoalChip] = useState<string | null>(
    initialGoal
      ? GOAL_CHIPS.find((c) => c.value.toLowerCase() === initialGoal.toLowerCase())?.value || null
      : null
  );
  const [notes, setNotes] = useState("");

  const handleHowMetChip = (value: string) => {
    if (selectedHowMetChip === value) {
      setSelectedHowMetChip(null);
      setHowMet("");
    } else {
      setSelectedHowMetChip(value);
      setHowMet(value);
    }
  };

  const handleGoalChip = (value: string) => {
    if (selectedGoalChip === value) {
      setSelectedGoalChip(null);
      setGoal("");
    } else {
      setSelectedGoalChip(value);
      setGoal(value);
    }
  };

  if (generating) {
    return (
      <div className="flex flex-col items-center justify-center py-14">
        <div className="w-48 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full"
            style={{ animation: "introProgress 3s ease-in-out infinite" }}
          />
        </div>
        <p className="text-sm text-muted-foreground mt-4 animate-pulse">
          Drafting your email...
        </p>
        <style>{`
          @keyframes introProgress {
            0% { width: 10%; }
            50% { width: 75%; }
            100% { width: 95%; }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="py-4 animate-in fade-in duration-300">
      <div className="rounded-2xl bg-primary/[0.03] border border-primary/10 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-primary">
            Help us personalize this email
          </span>
        </div>

        {/* Question 1: How do you know them? */}
        <div className="mb-5">
          <label className="text-sm font-medium text-foreground block mb-2">
            How do you know {contactName}?
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {HOW_MET_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => handleHowMetChip(chip.value)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                  selectedHowMetChip === chip.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface-container-low text-muted-foreground border border-outline-variant/50 hover:border-outline-variant hover:text-foreground"
                }`}
              >
                {chip.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleHowMetChip(COLD_CHIP.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                selectedHowMetChip === COLD_CHIP.value
                  ? "bg-amber-600 text-white"
                  : "bg-amber-50 text-amber-700 border border-amber-200 hover:border-amber-300"
              }`}
            >
              {COLD_CHIP.label}
            </button>
          </div>
          <input
            type="text"
            value={howMet}
            onChange={(e) => {
              setHowMet(e.target.value);
              setSelectedHowMetChip(null);
            }}
            placeholder="Or type: Stanford Engineering career fair, Tuesday..."
            className="w-full h-9 px-3 rounded-lg border border-outline-variant/50 bg-white text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
          />
        </div>

        {/* Question 2: What's your goal? */}
        <div className="mb-5">
          <label className="text-sm font-medium text-foreground block mb-2">
            What&apos;s your goal?
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {GOAL_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => handleGoalChip(chip.value)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                  selectedGoalChip === chip.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface-container-low text-muted-foreground border border-outline-variant/50 hover:border-outline-variant hover:text-foreground"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              setSelectedGoalChip(null);
            }}
            placeholder="Or describe your goal..."
            className="w-full h-9 px-3 rounded-lg border border-outline-variant/50 bg-white text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
          />
        </div>

        {/* Question 3: Anything specific? */}
        <div className="mb-5">
          <label className="text-sm font-medium text-foreground block mb-2">
            Anything specific you want to mention?{" "}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g., We talked about their PM internship program"
            className="w-full h-9 px-3 rounded-lg border border-outline-variant/50 bg-white text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
          />
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-destructive/5 border border-destructive/10 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Skip — draft without context
          </button>
          <button
            type="button"
            onClick={() => onGenerate({ howMet, goal, notes })}
            className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Generate draft
          </button>
        </div>
      </div>
    </div>
  );
}
