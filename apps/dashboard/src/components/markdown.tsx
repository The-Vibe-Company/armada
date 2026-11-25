"use client";

import { Fragment, memo, type ReactNode, useMemo } from "react";
import { CopyButton } from "@/components/copy-button";
import { type Block, type Inline, parseMarkdownBlock, splitMarkdownBlocks } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/** Agent text as Markdown, rendered from a parsed tree: React escapes every string, no HTML is interpreted. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const segments = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed break-words", className)}>
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond their position in the text.
        <MarkdownBlock key={index} source={segment} />
      ))}
    </div>
  );
});

const MarkdownBlock = memo(function MarkdownBlock({ source }: { source: string }) {
  const block = useMemo(() => parseMarkdownBlock(source), [source]);
  return block ? <BlockView block={block} /> : null;
});

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return <p className="whitespace-pre-wrap">{inline(block.children)}</p>;
    case "heading": {
      const Tag = (["h3", "h4", "h5"] as const)[block.level - 1] ?? "h5";
      return (
        <Tag className={cn("font-semibold tracking-tight", block.level === 1 ? "text-base" : "text-sm")}>
          {inline(block.children)}
        </Tag>
      );
    }
    case "code":
      return (
        <div className="overflow-hidden rounded-lg border border-border/80 bg-muted/40">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground">
            <span className="font-mono font-medium select-none" data-code-language>
              {block.language || "text"}
            </span>
            <CopyButton
              value={block.text}
              label={block.language ? `Copy ${block.language} code` : "Copy code"}
              showLabel
              className="h-6 px-2 text-[11px]"
            />
          </div>
          <pre
            className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed"
            data-language={block.language || undefined}
          >
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their position.
        <li key={index} className="pl-1 whitespace-pre-wrap">
          {inline(item)}
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5">{items}</ul>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 pl-3 whitespace-pre-wrap text-muted-foreground">
          {inline(block.children)}
        </blockquote>
      );
    case "rule":
      return <hr className="border-border" />;
  }
}

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: inline runs have no identity beyond their position.
    <Fragment key={index}>{inlineNode(node)}</Fragment>
  ));
}

function inlineNode(node: Inline): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "code":
      return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{node.text}</code>;
    case "strong":
      return <strong className="font-semibold">{inline(node.children)}</strong>;
    case "em":
      return <em>{inline(node.children)}</em>;
    case "link":
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="font-medium underline underline-offset-4"
        >
          {inline(node.children)}
        </a>
      );
  }
}
