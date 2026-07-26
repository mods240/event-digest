# セキュリティルール（差し替え版）
BUILD: 2026-07-26

投稿ページ(A)の追加に伴い、両方のルールを下記に**差し替えて**ください。
貼り付け後に「公開」を押すのを忘れずに。

---

## ① Realtime Database → ルール

```json
{
  "rules": {
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

**ポイント**
- 投稿レコードのキーは `{uid}_{時刻}` 形式。自分の uid で始まるキーしか読み書きできません
- 他人の投稿は一覧できず、内容も読めません
- 自分の投稿は取り消し（削除）できます
- ニックネームは20文字までに制限

## ② Storage → Rules

```
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {
    match /events/{eventId}/uploads/{userId}/{fileName} {
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

**ポイント**
- ファイルは `uploads/{自分のuid}/` の下にしか置けません
- 動画以外のファイル形式は拒否
- 2GB を超えるファイルは拒否（安全弁。通常は発火しません）
- 自分がアップロードしたファイルだけ削除できます

---

## 締切の設定（任意）

Realtime Database の「データ」タブで、手動で下記を追加すると
締切時刻を過ぎた時点で投稿ページが自動的に「受付終了」画面に切り替わります。

```
events / test-001 / config / deadline : 1785060000000
```

値は UNIX時間（ミリ秒）です。ブラウザのコンソールで
`new Date("2026-07-26T20:30:00+09:00").getTime()` を実行すると求められます。

即座に締め切りたい場合は `closed : true` を設定してください。
設定しなくてもページは正常に動作します（締切なしの状態）。
