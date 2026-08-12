"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkflowDTO } from "@/lib/apiTypes";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { Card, Empty, SkeletonText } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";

/**
 * Read once, not polled.
 *
 * Everything else in this app polls its route, and this is the one page where
 * that would be wrong: the form holds edits, and a poll answering with the
 * saved graph would either be discarded or would overwrite what is being typed.
 */
export default function EditWorkflowPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [workflow, setWorkflow] = useState<WorkflowDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workflows/${id}`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          workflow?: WorkflowDTO;
          error?: string;
        };
        if (!res.ok || !data.workflow) {
          throw new Error(data.error ?? `Could not read this workflow (${res.status})`);
        }
        setWorkflow(data.workflow);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoaded(true));
  }, [id]);

  return (
    <>
      <div className="mb-6">
        <Link href={`/workflows/${id}`} className="text-sm text-ink-muted">
          ← Back
        </Link>
      </div>

      {!loaded ? (
        <Card emphasis="quiet">
          <span className="sr-only">Reading this workflow…</span>
          <SkeletonText lines={4} />
        </Card>
      ) : workflow ? (
        <WorkflowEditor workflow={workflow} />
      ) : (
        <>
          <div role="alert">{error && <Notice tone="danger">{error}</Notice>}</div>
          <Card emphasis="quiet">
            <Empty>
              <div className="font-medium text-ink">No such workflow</div>
              <div className="mt-3">
                <Link href="/workflows">Back to workflows</Link>
              </div>
            </Empty>
          </Card>
        </>
      )}
    </>
  );
}
