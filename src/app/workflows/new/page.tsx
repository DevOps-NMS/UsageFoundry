"use client";

import Link from "next/link";
import { WorkflowEditor } from "@/components/WorkflowEditor";

export default function NewWorkflowPage() {
  return (
    <>
      <div className="mb-6">
        <Link href="/workflows" className="text-sm text-ink-muted">
          ← Workflows
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">
          New workflow
        </h1>
      </div>
      <WorkflowEditor workflow={null} />
    </>
  );
}
