"use client";

import { useParams } from "next/navigation";
import { UserList } from "@/components/UserList";

export default function FollowingPage() {
  const { username } = useParams<{ username: string }>();
  return <UserList username={username} kind="following" />;
}
