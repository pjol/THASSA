import React from "react";
import { useWindowDimensions, View } from "react-native";
import { CommentsList } from "./CommentsList";
import { Sheet } from "./ui";

// Instagram-style comments: a bottom sheet sliding up over the feed with the
// scrollable comment thread (and composer) inside — posts never navigate away
// just to read comments.

export function CommentsSheet({
  postId,
  visible,
  onClose,
}: {
  postId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  return (
    <Sheet visible={visible} onClose={onClose} title="Comments">
      <View style={{ height: Math.min(height * 0.62, 560) }}>
        <CommentsList subjectType="post" subjectId={postId} />
      </View>
    </Sheet>
  );
}
