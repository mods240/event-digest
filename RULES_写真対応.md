# セキュリティルールの追加（写真の投稿に対応）
BUILD: 2026-07-27

Storage のルールで、画像の投稿を許可します。
Firebaseコンソール → Storage → ルール で下記に**差し替えて**「公開」。

```
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {
    match /events/{eventId}/uploads/{userId}/{fileName} {
      allow read:   if request.auth != null && request.auth.uid == userId;
      allow create: if request.auth != null
                    && request.auth.uid == userId
                    && request.resource.size < 2 * 1024 * 1024 * 1024
                    && (request.resource.contentType.matches('video/.*')
                        || request.resource.contentType.matches('image/.*'));
      allow delete: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

変更点は `contentType` の条件に画像を足しただけです。
Realtime Database のルールは変更不要です。
