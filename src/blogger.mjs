import { google } from "googleapis";

export async function publishPost(auth, { blogId, title, contentHtml, label }) {
  const blogger = google.blogger({ version: "v3", auth });
  const { data } = await blogger.posts.insert({
    blogId,
    isDraft: false,
    requestBody: {
      title,
      content: contentHtml,
      labels: label ? [label] : [],
    },
  });
  return { url: data.url, id: data.id };
}

export async function detectBlogId(auth, blogUrl) {
  const blogger = google.blogger({ version: "v3", auth });
  const { data } = await blogger.blogs.getByUrl({ url: blogUrl });
  return data.id;
}
