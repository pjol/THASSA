"use client";

import { useParams } from "next/navigation";
import { UserList } from "@/components/UserList";

export default function FollowersPage() {
  const { username } = useParams<{ username: string }>();
  return <UserList username={username} kind="followers" />;
}
