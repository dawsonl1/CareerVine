"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { useEffect, useRef } from "react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  Link as LinkIcon,
  Undo,
  Redo,
} from "lucide-react";

interface RichTextEditorProps {
  content?: string;
  placeholder?: string;
  onChange?: (html: string) => void;
  className?: string;
}

export function RichTextEditor({ content = "", placeholder = "Write your message…", onChange, className = "" }: RichTextEditorProps) {
  const lastEmittedHtml = useRef(content);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        blockquote: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "text-primary underline" },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none focus:outline-none min-h-[180px] px-4 py-3 text-sm text-foreground [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1",
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      lastEmittedHtml.current = html;
      onChange?.(html);
    },
  });

  // Sync external content changes (e.g. "Insert availability") into TipTap
  useEffect(() => {
    if (!editor) return;
    if (content !== lastEmittedHtml.current) {
      lastEmittedHtml.current = content; // Set before setContent so onUpdate echo doesn't retrigger
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  if (!editor) return null;

  const toggleLink = () => {
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("URL:");
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
  };

  const btnClass = (active: boolean) =>
    `p-1.5 rounded transition-colors cursor-pointer ${
      active
        ? "bg-primary/15 text-primary"
        : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
    }`;

  return (
    <div className={`rounded-[4px] border border-outline bg-surface-container-low overflow-hidden ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-outline-variant/50 bg-surface-container-low/50">
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={btnClass(editor.isActive("bold"))} title="Bold">
          <Bold className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={btnClass(editor.isActive("italic"))} title="Italic">
          <Italic className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleStrike().run()} className={btnClass(editor.isActive("strike"))} title="Strikethrough">
          <Strikethrough className="h-4 w-4" />
        </button>

        <div className="w-px h-5 bg-outline-variant/50 mx-1" />

        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={btnClass(editor.isActive("bulletList"))} title="Bullet list">
          <List className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btnClass(editor.isActive("orderedList"))} title="Numbered list">
          <ListOrdered className="h-4 w-4" />
        </button>

        <div className="w-px h-5 bg-outline-variant/50 mx-1" />

        <button type="button" onClick={toggleLink} className={btnClass(editor.isActive("link"))} title="Link">
          <LinkIcon className="h-4 w-4" />
        </button>

        <div className="flex-1" />

        <button type="button" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-surface-container-low disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors" title="Undo">
          <Undo className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-surface-container-low disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors" title="Redo">
          <Redo className="h-4 w-4" />
        </button>
      </div>

      {/*
        TipTap renders a `contenteditable` div here, not a form control, so it
        has no role and no accessible name to target. E2E types into it with
        pressSequentially (CAR-189).
      */}
      <EditorContent editor={editor} data-testid="rich-text-editor" />
    </div>
  );
}
