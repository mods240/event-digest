# セキュリティルールの追加(スタッフ撮影アプリ対応)
BUILD: 2026-07-28

スタッフ撮影アプリは、一般参加者の投稿(`uploads`)とは別のパス
(`staffUploads`)を使います。Realtime Database と Storage の両方に、
このパス用のルールを追加する必要があります。

## Realtime Database

Firebaseコンソール → Realtime Database → ルール で、
`events/$eventId` の中に `staffUploads` を追加してください。

```json
{
  "rules": {
    "activeEvent": {
      ".read": "auth != null",
      ".write": false
    },
    "events": {
      "$eventId": {
        "config": {
          ".read": "auth != null",
          ".write": false
        },
        "uploads": {
          "$uploadId": {
            ".read": false,
            ".write": "auth != null && $uploadId.beginsWith(auth.uid + '_')",
            ".validate": "newData.hasChildren(['nickname','fileName','storagePath','uid']) && newData.child('uid').val() === auth.uid && newData.child('nickname').isString() && newData.child('nickname').val().length <= 20"
          }
        },
        "staffUploads": {
          "$uploadId": {
            ".read": false,
            ".write": "auth != null && $uploadId.beginsWith(auth.uid + '_')",
            ".validate": "newData.hasChildren(['storagePath','uid']) && newData.child('uid').val() === auth.uid"
          }
        },
        "myUploads": {
          "$uid": {
            ".read": "auth != null && auth.uid === $uid",
            ".write": "auth != null && auth.uid === $uid"
          }
        }
      }
    }
  }
}
```

`staffUploads` は `uploads` とほぼ同じ形ですが、ニックネームの文字数
制限などは設けていません(スタッフ名は運用側で管理するため)。

## Storage

Firebaseコンソール → Storage → ルール で、`staffUploads` 用の
パスを追加してください。

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
    match /events/{eventId}/staffUploads/{userId}/{fileName} {
      allow read:   if request.auth != null && request.auth.uid == userId;
      allow create: if request.auth != null
                    && request.auth.uid == userId
                    && request.resource.size < 2 * 1024 * 1024 * 1024
                    && request.resource.contentType.matches('video/.*');
      allow delete: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

写真投稿には対応していません(スタッフ撮影アプリは動画専用のため、
`image/.*` の許可は入れていません)。

## 導入手順のまとめ

1. 上記2つのルールを、それぞれ「公開」する
2. `staff/index.html` を Vercel にデプロイし、URLを確認する
   (`upload/index.html` と同様の手順。新しい Vercel プロジェクトとして
   デプロイしてください)
3. パネルの「投稿用QRコード」→「スタッフ撮影用」タブで、そのURLを入力
4. スタッフのスマホでQRを読み取り、「ホーム画面に追加」してもらう
5. 以後はホーム画面のアイコンから開くだけで、そのイベント宛てに撮影・
   自動送信され続けます

## 動作の要点(運用者向けメモ)

- QRを読んだ瞬間にそのイベントに固定されます。次のイベントでは、
  そのイベント用のQRを読み直してもらってください
- 撮影した動画はカメラロールに保存されません。アプリ内にだけ残ります
- 送信が成功した動画も、**翌日の午前2時まで**は端末に残ります
  (安心のための猶予期間)。それを過ぎると自動で消えます
- 送信に失敗した動画は自動では消えません。「送信状況」画面から
  手動で再送できます
