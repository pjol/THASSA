import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { CommentsList } from "../../components/CommentsList";
import { PostCard } from "../../components/PostCard";
import { ErrorState, Loading } from "../../components/states";
import { useApi } from "../../lib/api";
import type { Post } from "../../lib/types";

// Post detail: the full card (media, market, actions) + threaded comments.
export default function PostDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();

  const q = useQuery({
    queryKey: ["post", id],
    enabled: !!id,
    queryFn: () => api.get<Post>(`/v1/posts/${id}`),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;

  return (
    <CommentsList
      subjectType="post"
      subjectId={q.data.id}
      header={<PostCard post={q.data} active />}
    />
  );
}
