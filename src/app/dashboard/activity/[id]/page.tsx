import type { Metadata } from "next";
import { EventDetail } from "@/components/event-detail";
import { requireUser } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Event · GitHub Automation Bot" };

export default async function EventPage({ params }: PageProps<"/dashboard/activity/[id]">) {
  await requireUser();
  const { id } = await params;
  // Ownership is enforced by GET /api/events/:id (another user's id → 404).
  return <EventDetail id={id} />;
}
