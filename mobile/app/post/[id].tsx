import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { CommentsList } from "../../components/CommentsList";
import { PostCard } from "../../components/PostCard";
import { ListRowsSkeleton, PostCardSkeleton } from "../../components/skeletons";
import { ErrorState } from "../../components/states";
import { useApi } from "../../lib/api";
import type { Post } from "../../lib/types";

// Post detail: the full card (media, market, actions) + threaded comments.
export default function PostDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();

  const q = useQuery({
    queryKey: ["post", id],
    enabled: !!id,
    queryFn: () => api.get<{ post: Post }>(`/v1/posts/${id}`).then((r) => r.post),
  });

  if (q.isLoading) {
    // Post-shaped card + a few comment rows while the first load is in flight.
    return (
      <View style={{ paddingTop: 12 }}>
        <PostCardSkeleton />
        <ListRowsSkeleton rows={3} avatarSize={32} />
      </View>
    );
  }
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;

  return (
    <CommentsList
      subjectType="post"
      subjectId={q.data.id}
      header={<PostCard post={q.data} active />}
    />
  );
}
