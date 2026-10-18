# 調整用パラメータ

数値はすべてこのフォルダの JSON に入っています。コードを触らずに、数値を書き換えて保存するだけで調整できます。

- 開発サーバー（`npm run dev`）で遊んでいる間は、保存するとページが自動で読み直されます。
- ゲーム中に **Esc** で一時停止すると、画面右に調整パネルが出ます。その場で数値を変えて試し、「JSONをコピー」でこのファイルに貼り付けられます。

単位は特に書いていない限り、距離が m（メートル）、時間が秒、速度が m/秒、角度が度です。

## movement.json（移動）

### 地上
| 名前 | 初期値 | 意味 |
|---|---|---|
| WALK_SPEED | 5.0 | 歩きの速度 |
| SPRINT_SPEED | 8.0 | ダッシュ速度（Shift を押しながら前進） |
| CROUCH_SPEED | 2.5 | しゃがみ歩きの速度 |
| GROUND_ACCEL | 45 | 地上で目標速度まで加速する速さ（m/秒²） |
| GROUND_DECEL | 40 | 入力をやめたときに止まる速さ（m/秒²） |
| OVERSPEED_FRICTION | 6 | 通常より速いとき（スライディングやジャンプの勢いが残っているとき）に地上で減速する速さ |
| OVERSPEED_STEER | 6 | 通常より速いときに、地上で向きを変えられる強さ |
| LANDING_GRACE | 0.12 | 着地してから減速が始まるまでの猶予。この間にジャンプすれば勢いを失わない（バニーホップ） |
| MAX_HORIZONTAL_SPEED | 25 | 水平方向の速度の上限 |

### ジャンプ・空中
| 名前 | 初期値 | 意味 |
|---|---|---|
| JUMP_VELOCITY | 6.8 | ジャンプ初速（高さ約 1.28m。フェーズ5で 6.0 から上げた） |
| DOUBLE_JUMP_VELOCITY | 6.8 | 2段ジャンプ初速（2段で合わせて約 2.6m） |
| DOUBLE_JUMP_REDIRECT | 0.7 | 2段ジャンプで入力方向へ向きを変える割合（0＝変えない、1＝完全に入力方向） |
| DOUBLE_JUMP_MIN_HSPEED | 4.0 | 2段ジャンプで入力方向に最低限出る水平速度 |
| COYOTE_TIME | 0.12 | 足場から落ちた直後でも、地上ジャンプとして扱う猶予 |
| JUMP_BUFFER | 0.12 | 着地の少し前に押したジャンプを、着地した瞬間に実行する猶予 |
| GRAVITY | 18.0 | 重力加速度（m/秒²） |
| MAX_FALL_SPEED | 40 | 落下速度の上限 |
| AIR_CONTROL | 0.3 | 空中での方向転換のしやすさ（0〜1） |
| AIR_STEER_RATE | 10 | 空中制御の基準の強さ（AIR_CONTROL と掛け合わせて使う） |
| AIR_MIN_SPEED | 5.0 | 空中で入力したときに目指す最低の水平速度 |

### スライディング
| 名前 | 初期値 | 意味 |
|---|---|---|
| SLIDE_BOOST | 3.0 | スライディング開始時の加速量 |
| SLIDE_FRICTION | 4.0 | スライディング中の減速（m/秒²） |
| SLIDE_COOLDOWN | 1.0 | 加速付きスライディングの再使用待ち。待ち中でもスライディング自体はできるが加速しない |
| SLIDE_MIN_SPEED | 6.5 | スライディングを始めるのに必要な速度 |
| SLIDE_END_SPEED | 3.5 | この速度まで落ちるとしゃがみ歩きに戻る |
| SLIDE_STEER | 1.5 | スライディング中に向きを変えられる強さ |
| SLIDE_GRAVITY_SCALE | 1.6 | 坂道でスライディングが加速・減速する強さ（重力の何倍が斜面方向に効くか。1.6 なら約8°より急な下り坂で加速する） |

### 壁走り
| 名前 | 初期値 | 意味 |
|---|---|---|
| WALLRUN_MIN_SPEED | 0 | 壁走り開始に必要な水平速度。0 なら走っていなくても（その場からのジャンプでも）壁走りに入れる |
| WALLRUN_ENTRY_MIN_SPEED | 6.5 | 壁走りを始めたときの最低速度。遅く入ってもこの速さから走り出す |
| WALLRUN_SPEED | 9.0 | 壁走り中の速度（これより遅ければ加速、速ければゆっくり減速） |
| WALLRUN_ACCEL | 8.0 | 壁走り中に WALLRUN_SPEED まで加速する速さ |
| WALLRUN_OVERSPEED_DECEL | 2.0 | WALLRUN_SPEED より速いときの減速 |
| WALLRUN_MAX_TIME | 1.8 | 壁走りの最大継続時間 |
| WALLRUN_HOLD_TIME | 0.8 | 壁走りを始めてから落ち始めるまでの時間。この間は高さを保つ |
| WALLRUN_GRAVITY_SCALE | 0.15 | 落ち始めたときの重力倍率 |
| WALLRUN_GRAVITY_RAMP | 4.0 | 時間とともに重力が強まる度合い。落ち始めてから最大継続時間に達するまでに「GRAVITY_SCALE × (1 + RAMP)」倍まで強まる |
| WALLRUN_MIN_ANGLE / MAX_ANGLE | 0 / 75 | 壁に入る角度の範囲（0＝壁と平行、90＝壁に正面からぶつかる） |
| WALLRUN_ENTRY_SPEED_KEEP | 0.9 | 斜めに壁に入ったとき、元の速度の何割を壁沿いの速度として引き継ぐか |
| WALLRUN_START_MAX_UP / MIN_UP | 2.5 / 0.5 | 壁走り開始時の上下方向の速度の範囲（上昇しすぎ・落下しすぎを防ぐ） |
| WALLRUN_ATTACH_DIST | 0.25 | 壁にこの距離まで近づけば張り付ける（平行に近づいた場合用） |
| WALLRUN_REATTACH_DELAY | 0.3 | 壁から離れてから、同じ壁にまた張り付けるまでの時間（秒）。別の壁にはすぐ張り付ける |
| WALLRUN_REATTACH_MAX_RISE | 0.0 | 同じ壁にまた張り付けるのは、離れたときの高さ＋この値（m）まで。0 なら離れたときより上では張り付けない（同じ壁で壁ジャンプをくり返して登れないように） |
| WALLRUN_MIN_HEIGHT | 0.6 | 地面からこの高さ以上でないと壁走りしない |
| WALLRUN_END_SPEED | 3.5 | 壁走り中にこの速度まで落ちると壁から離れる |
| WALLJUMP_VELOCITY | 7.0 | 壁から跳ぶ時の速度（壁から離れる方向＋上方向の合計） |
| WALLJUMP_UP_ANGLE | 52 | 壁ジャンプの上向きの角度（大きいほど上へ、小さいほど壁から遠くへ） |
| WALLJUMP_LOOK_INFLUENCE | 0.35 | 壁ジャンプの方向を、見ている方向へ寄せる割合 |
| CAMERA_TILT_WALLRUN | 12 | 壁走り中のカメラの傾き（度） |

### よじ登り・体の大きさ
| 名前 | 初期値 | 意味 |
|---|---|---|
| MANTLE_MAX_HEIGHT / MIN_HEIGHT | 1.5 / 0.35 | よじ登れる縁の高さ（足元から） |
| MANTLE_TIME | 0.28 | よじ登りにかかる時間 |
| PLAYER_RADIUS | 0.4 | 当たり判定の半径 |
| STAND_HEIGHT / CROUCH_HEIGHT | 1.8 / 1.05 | 立ち・しゃがみの身長 |
| EYE_FROM_TOP | 0.14 | 頭のてっぺんから目までの距離 |
| GROUND_SNAP | 0.35 | 下り坂や段差で、地面に吸い付ける距離 |
| STEP_HEIGHT | 0.35 | 歩いて自動で乗り越えられる段差の高さ（当たり判定の半径より少し小さい値まで） |
| WALKABLE_SLOPE_DEG | 50 | 歩ける坂の最大角度（これより急な面は壁扱い） |

## camera.json（視点・操作）
| 名前 | 初期値 | 意味 |
|---|---|---|
| FOV | 100 / 120 / 140 | 視野角（度。画面の**横**の角度。仕様の範囲は 70〜110。フェーズ6で、縦の角度から横の角度に直した（前は縦 95°＝横 約124° で、仕様の範囲より広かった）） |
| FOV_SPEED_KICK | 10 | 速く動いているときに視野角を広げる最大量 |
| FOV_KICK_START_SPEED / FULL_SPEED | 8.5 / 18 | 視野角が広がり始める速度・最大になる速度 |
| MOUSE_SENSITIVITY | 0.0022 | マウス感度（1ピクセルあたりの回転角、ラジアン） |
| INVERT_Y | false | 上下反転 |
| TILT_LERP | 9 | カメラの傾きが追従する速さ |
| EYE_HEIGHT_LERP | 14 | しゃがみ・スライディングで目の高さが変わる速さ |
| LANDING_DIP_PER_SPEED / MAX | 0.012 / 0.22 | 着地時に視点が沈む量（落下速度1あたり／最大） |
| HEAD_BOB | 0.035 | 走行中の視点の揺れの大きさ |
| AUTO_SPRINT | false | true にすると Shift を押さなくても前進でダッシュする |

## weapons.json（武器）

`COMMON` は全武器に共通の値、`ar` `lmg` `smg` `shotgun` `sniper` が各武器。

### COMMON
| 名前 | 初期値 | 意味 |
|---|---|---|
| MAX_RANGE | 300 | 弾が届く最大距離 |
| MOVE_SPREAD_ADD | 1.2 | 動いているときに増えるばらつき（度、ダッシュ速度で最大） |
| AIR_SPREAD_MUL / WALLRUN_SPREAD_MUL / SLIDE_SPREAD_MUL | 1.6 / 1.3 / 1.2 | 空中・壁走り中・スライディング中のばらつきの倍率 |
| CROUCH_SPREAD_MUL | 0.85 | しゃがみ中のばらつきの倍率 |
| RECOIL_RECOVERY | 0.45 | 撃ち終わったあと、上に跳ねた視点を自動で戻す割合 |
| TARGET_HEALTH | 100 | 射撃の的の体力 |
| TARGET_RESPAWN_TIME | 2.5 | 的が倒れてから復活するまでの秒数 |
| TARGET_REGEN_DELAY | 3.0 | 的がこの秒数撃たれなければ体力が満タンに戻る |
| INFINITE_RESERVE | true | 予備弾を無限にする（リロードは必要）。false にすると各武器の RESERVE が上限になる |

### 訓練用タレット（COMMON）
テスト部屋の「アビリティ訓練場」にある、プレイヤーを撃ってくる的。
| 名前 | 初期値 | 意味 |
|---|---|---|
| TURRET_HEALTH | 150 | 体力 |
| TURRET_RANGE | 38 | この距離より近く、間に壁のないプレイヤーを狙う |
| TURRET_LOCK_TIME | 0.8 | 狙いを定めてから撃ち始めるまでの秒数（この間、赤いレーザーが出る） |
| TURRET_FIRE_INTERVAL | 0.28 | 撃つ間隔 |
| TURRET_DAMAGE | 6 | 1発のダメージ |
| TURRET_SPREAD | 1.4 | 弾のばらつき（度） |
| TURRET_TURN_SPEED | 150 | 向きを変える速さ（度/秒） |
| TURRET_CLOAK_DETECT_RANGE / TURRET_CLOAK_SPREAD_MUL | 7 / 4 | 光学迷彩の相手は、この距離より近くないと狙わない / 狙ってもばらつきがこの倍率になる |
| TURRET_RESPAWN_TIME | 6 | 壊してから直るまでの秒数 |

### グレネード（COMMON）
フラググレネードの数値。ほかの種類（`grenades.json`）で書いていない値も、ここと同じになる。

| 名前 | 初期値 | 意味 |
|---|---|---|
| GRENADE_COUNT | 2 | 所持数 |
| GRENADE_REGEN_TIME | 6 | 1つ回復するまでの秒数（0 にすると回復しない。弾薬補給所とスタート地点では満タンになる） |
| GRENADE_FUSE | 3.0 | 投げてから爆発するまでの秒数 |
| GRENADE_THROW_SPEED | 19 | 投げる速さ（m/秒） |
| GRENADE_UP_ANGLE | 9 | 視線より上に投げる角度（度） |
| GRENADE_INHERIT_VEL | 0.5 | 自分の移動速度を引き継ぐ割合（走りながら投げると遠くへ飛ぶ） |
| GRENADE_GRAVITY | 16 | グレネードにかかる重力 |
| GRENADE_BOUNCE / GRENADE_FRICTION | 0.42 / 0.65 | 跳ね返りの強さ / 当たった面に沿った速さが残る割合 |
| GRENADE_SIZE | 0.08 | 当たり判定の半径 |
| GRENADE_BLAST_RADIUS / GRENADE_INNER_RADIUS | 6.0 / 1.5 | 爆風の届く半径 / 最大ダメージになる半径 |
| GRENADE_MAX_DAMAGE / GRENADE_MIN_DAMAGE | 110 / 20 | 中心付近 / 爆風の端のダメージ。間に壁があれば届かない |
| GRENADE_COOLDOWN | 0.8 | 次を投げられるまでの秒数 |
| GRENADE_THROW_LOCK | 0.4 | 投げた直後に撃てない秒数 |

## グレネードの種類（grenades.json）

ロードアウトで 1 つ選ぶ。どれにも NAME（名前）・SHORT（英語の短い名前。キルログ）・DESC（説明）・STICK（当たった所に刺さる）がある。COUNT（所持数）・REGEN_TIME（1 つ回復する秒）・FUSE（効き始めるまでの秒）・THROW_SPEED（投げる速さ）・GRAVITY（重力）・RADIUS / INNER_RADIUS・MAX_DAMAGE / MIN_DAMAGE（爆風）は、書いていなければフラグ（weapons.json の COMMON.GRENADE_*）と同じ。frag は COMMON の値をそのまま使う。

| 種類 | 項目（初期値） |
|---|---|
| arc（アークグレネード） | COUNT 2、REGEN_TIME 7、FUSE 1.4、RADIUS 5.5・INNER_RADIUS 1.5、MAX_DAMAGE 32・MIN_DAMAGE 12、SHOCK_TIME 3（電撃の秒）、SHOCK_SLOW 0.5（動きが鈍る割合。残りが半分を切ると戻っていく）、DRONE_MUL 3.5（ドローンへのダメージの倍率） |
| firestar（ファイアスター） | 刺さる。COUNT 2、REGEN_TIME 8、THROW_SPEED 24、GRAVITY 9、ARM_TIME 0.2（刺さってから燃え始めるまで）、FIRE_TIME 5（燃える秒）、FIRE_RADIUS 2.6・FIRE_HEIGHT 1.8（燃える範囲）、FIRE_DPS 30（毎秒のダメージ。0.25 秒ごとに与える）、IMPACT_DAMAGE 20（敵に刺さったとき）、STUCK_DPS_MUL 1.4（刺さった敵が受ける炎の倍率） |
| gravity（グラビティスター） | 刺さる。COUNT 2、REGEN_TIME 8、THROW_SPEED 24、GRAVITY 9、ARM_TIME 0.35、PULL_TIME 1.8（引き寄せる秒）、PULL_RADIUS 7（引き寄せる範囲）、PULL_ACCEL 30（引き寄せる強さ）、PULL_LIFT 1.2（渦の中心の高さ）、RADIUS 4.5・INNER_RADIUS 1.2、MAX_DAMAGE 70・MIN_DAMAGE 25（最後の爆発） |
| smoke（スモークグレネード） | COUNT 2、REGEN_TIME 10、FUSE 1.0、SMOKE_TIME 12（煙の秒）、SMOKE_RADIUS 6.5（煙の半径）、SMOKE_GROW 1.4（広がりきるまでの秒）、SMOKE_FADE 2.0（最後に薄れていく秒） |
| satchel（サッチェル） | 張り付く。COUNT 2、REGEN_TIME 10、THROW_SPEED 15、ARM_TIME 0.6（投げてから起爆できるまで）、LIFE 90（消えるまでの秒）、RADIUS 5.5・INNER_RADIUS 1.6、MAX_DAMAGE 150・MIN_DAMAGE 35 |

### 格闘（COMMON）
| 名前 | 初期値 | 意味 |
|---|---|---|
| MELEE_DAMAGE | 100 | ダメージ（的は一撃） |
| MELEE_RANGE | 1.9 | その場で届く距離 |
| MELEE_LUNGE_RANGE / MELEE_LUNGE_SPEED | 3.2 / 7.0 | これより近い的には踏み込んで殴る / 踏み込みの速さ |
| MELEE_ANGLE | 40 | 正面から何度までの的に当たるか |
| MELEE_COOLDOWN | 0.75 | 次に殴れるまでの秒数 |
| MELEE_LOCK | 0.4 | 殴った直後に撃てない秒数 |

### 各武器
武器は 12 丁（ar・burst・smg・psmg・lmg・spinlmg・shotgun・autosg・sniper・marksman・pistol・revolver）。武器種ごとに 2 丁ずつ。

| 名前 | 意味 |
|---|---|
| NAME / SHORT | 固有の名前（例：ストラタ）・英字の短い名前（例：STRATA。キルログ・HUD の武器の欄） |
| CLASS | 武器種（ar・smg・lmg・shotgun・sniper・pistol）。持ち方・音・照準・ボットの使い方の元になる |
| BRIEF | 一言の説明（26 文字まで）。ロードアウトのカード・HUD（持ち替えたとき）に出す |
| RANGE / DESC | ロードアウトの画面に出す、有効距離のめやすと詳しい説明文 |
| BURST / BURST_DELAY | 1 回の引き金で撃つ弾数（1 なら普通。トライデントは 3）/ 点射のあとの待ち（秒）。点射の中の速さは RPM |
| RPM_MIN / SPINUP_TIME | 回転式（サイクロン）：撃ち始めの連射速度 / 撃ち続けて RPM まで上がる時間（秒。0 なら回転式ではない）。止めると SPINUP_TIME の 1.6 倍の時間で回転が落ちる |
| FIRE_WHILE_SPRINT | true ならダッシュしたまま撃てる（ハンドガン）。false なら撃つとダッシュが止まる |
| DEFAULT_SIGHT / SIGHTS / ATTACHMENTS | 最初から付いているサイト / 付けられるサイト / 付けられるアタッチメント（名前は attachments.json） |
| DAMAGE | 1発（ショットガンは1粒）のダメージ |
| PELLETS | 1回に出る弾の数（ショットガンは 8） |
| RPM | 連射速度（発/分） |
| AUTO | true なら押しっぱなしで連射、false なら1回押すごとに1発 |
| MAG_SIZE / RESERVE | 装弾数 / 予備弾の上限（INFINITE_RESERVE が true なら使わない） |
| RELOAD_TIME | リロード時間（RELOAD_PER_SHELL が true なら1発込める時間） |
| RELOAD_PER_SHELL / RELOAD_START_DELAY | 1発ずつ込めるか / 込め始めるまでの時間 |
| FALLOFF_START / FALLOFF_END / FALLOFF_MIN_MUL | 威力が下がり始める距離 / 最も下がる距離 / そのときの倍率 |
| HEAD_MUL | 頭に当たったときの倍率 |
| HIP_SPREAD / ADS_SPREAD | 腰だめ・エイム時のばらつき（度。円錐の半角） |
| SPREAD_PER_SHOT / SPREAD_MAX_ADD / SPREAD_RECOVERY | 1発ごとに広がる量 / 広がりの上限 / 撃ち止めてから戻る速さ（度/秒） |
| SUSTAINED_MIN_MUL / SUSTAINED_TIME | 撃ち続けると集弾が良くなる武器用（LMG）。SUSTAINED_TIME 秒撃ち続けるとばらつきが MIN_MUL 倍になる |
| RECOIL_PITCH / RECOIL_YAW | 1発ごとに視点が上・左右に跳ねる量（度） |
| ADS_TIME | エイムしきるまでの時間 |
| ADS_FOV_MUL | エイム時の視野角の倍率（小さいほどズーム） |
| ADS_MOVE_MUL | エイム中の移動速度の倍率 |
| MOVE_SPEED_MUL | 持っているときの移動速度の倍率 |
| SWAP_TIME | この武器に持ち替えてから撃てるまでの時間 |
| SCOPE | エイム時にスコープ表示にする |

## attachments.json（武器のカスタマイズ）
武器ごとに **サイト 1 つ** と **アタッチメント 2 つまで** を付けられる（ロードアウト画面で選ぶ）。どの武器に何が付けられるかは weapons.json の SIGHTS・ATTACHMENTS。
数値は「付けた物の効き目を、武器の数値に当てはめたもの」をゲームが使う（shared/weaponCustom.ts）。

### SIGHTS（サイト）
| 名前 | 意味 |
|---|---|
| NAME / SHORT / DESC | 表示名・略称・説明文 |
| KIND | iron＝照門と照星、dot・holo＝等倍に近い光学サイト、optic＝倍率のあるスコープ（武器は見えたまま）、scope＝画面いっぱいにのぞくスコープ |
| FOV_MUL | エイム時の視野角の倍率（小さいほど拡大。0.59 ≒ 2 倍、0.41 ≒ 3 倍）。0 なら武器のもとの値（ADS_FOV_MUL） |
| ADS_TIME_MUL / ADS_SPREAD_MUL | のぞく時間・エイム中のばらつきの倍率 |
| RETICLE | 画面に重ねる照準の形（dot・holo・chevron・ranged・threat・sniper・variable） |
| ZOOMS | 倍率を切り替えられるスコープの、視野角の倍率の段階（のぞいている間にホイールで切り替え） |
| THREAT | true なら、のぞいている間、見えている敵を赤く浮かび上がらせる |

| サイト | 倍率 | のぞく時間 | 特徴 |
|---|---|---|---|
| アイアンサイト | 武器のまま（約 1.2〜1.4 倍） | ×1 | 視界が広い |
| レッドドット | 武器のまま | ×1 | 赤い点。エイム中のばらつき ×0.9 |
| ホロサイト | 約 1.5 倍 | ×1.05 | 円と点。ばらつき ×0.9 |
| 2倍スコープ | 2 倍 | ×1.12 | 山形の照準。ばらつき ×0.85 |
| 3倍スコープ | 3 倍 | ×1.22 | 距離の目盛り。ばらつき ×0.8 |
| スレットスコープ | 約 1.6 倍 | ×1.3 | 見えている敵が赤く浮かぶ |
| スナイパースコープ | 武器のまま（約 4.6 倍） | ×1 | 画面いっぱい（狙撃銃だけ） |
| 可変スコープ | 4 倍 ⇄ 8 倍 | ×1.12 | 画面いっぱい・ホイールで切り替え（狙撃銃だけ） |

### ATTACHMENTS（アタッチメント）
| 名前 | 意味 |
|---|---|
| NAME / SHORT / DESC | 表示名・略称・説明文 |
| GROUP | 同じグループの物は 1 つまで（muzzle＝銃口に付ける物） |
| MODS | 効き目。`<項目>_MUL` は武器の数値に掛け、`<項目>_ADD` は足す。SUPPRESSED（発砲音を消す）・LASER（レーザーの点）はそのまま入れる。MOVE_SPREAD_MUL は動いているときのばらつきの倍率 |

| アタッチメント | 効き目 |
|---|---|
| 拡張マガジン | 装弾数 ×1.4 |
| クイックリロード | リロード ×0.7 |
| サプレッサー（銃口） | 撃っても敵のミニマップに映らず、敵のボットに聞こえる距離 28m → 9m。射程 ×0.85 |
| コンペンセイター（銃口） | 反動 ×0.65、撃ち続けたときのばらつき ×0.75 |
| クイックストック | エイム・持ち替え ×0.7 |
| レーザーサイト | 腰だめのばらつき ×0.6。腰だめの間、狙っている所に赤い点 |
| ガンランナー | FIRE_WHILE_SPRINT を true にする（走りながらでも撃てる。撃ってもダッシュが止まらない）。ハンドガン（最初から走りながら撃てる）には付けられない |
| ロングバレル | 射程 ×1.3、エイム ×1.1 |

## characters.json（キャラクター）

### COMMON（全員共通）
| 名前 | 初期値 | 意味 |
|---|---|---|
| MAX_HEALTH | 100 | 体力 |
| REGEN_DELAY | 5.0 | ダメージを受けてから回復が始まるまでの秒数 |
| REGEN_RATE | 12 | 回復の速さ（1秒あたり） |
| RESPAWN_TIME | 2.0 | 倒されてから復活するまでの秒数（テスト部屋ではスタート地点で復活） |
| SELF_GRENADE_DAMAGE_MUL | 0.6 | 自分のグレネードの爆風を受けたときのダメージ倍率 |

### 各キャラクター
どのキャラクターも次の形です。数値の項目は、そのアビリティ・パッシブに使うものだけがあります。
| 名前 | 意味 |
|---|---|
| NAME / ROLE / COLOR / ORDER | 表示名 / 役割 / テーマカラー（HUD・選択画面・演出の色） / 選択画面の並び順 |
| ABILITY.TYPE | アビリティの種類（grapple・cloak・shield・sonar・overdrive・phase）。動きはこの種類で決まる |
| ABILITY.NAME / ABILITY.DESC | 表示名 / 説明文（選択画面に出る） |
| ABILITY.COOLDOWN | 使ってから次に使えるまでの秒数 |
| PASSIVE.NAME / PASSIVE.DESC | パッシブの表示名 / 説明文 |
| BOT | ボットがアビリティを使う場面（フェーズ6で使う。今はメモ） |

| キャラクター | アビリティの数値 | パッシブの数値 |
|---|---|---|
| メイア（ワイヤーフック） | RANGE 38（届く距離）、PULL_ACCEL 55 / PULL_MAX_SPEED 24（引き寄せの加速と最高速）、MAX_TIME 1.6（最長でこの秒数で離す）、RELEASE_DIST 1.6（刺さった点にこの距離まで近づいたら離す）、TARGET_PULL_DIST 4（的に当てたとき、的を引き寄せる距離）、TARGET_STAGGER_TIME 1.2（的がよろめいて止まる秒数）。外れたときは 1 秒だけ待てば使える | WALLRUN_TIME_MUL 1.3（壁走りできる時間の倍率） |
| パール（光学迷彩） | DURATION 5（効果時間）。撃つ・殴る・投げると解ける | FOOTSTEP_VOLUME 0.35（足音の大きさ。1 が普通） |
| ミランダ（シールドウォール） | DURATION 8、WIDTH 4.2 / HEIGHT 2.4（壁の大きさ）、DISTANCE 1.6（どれだけ前に出すか）。敵の弾だけを止め、味方は通り抜けて撃てる。出し直すと前の壁は消える | REGEN_DELAY 3（回復が始まるまで）、REGEN_RATE_MUL 2（回復の速さの倍率） |
| ソラ（パルスソナー） | RADIUS 40（届く範囲）、REVEAL_TIME 3（壁越しに見える秒数）、WAVE_SPEED 60（波が広がる速さ。遠い敵ほど少し遅れて見つかる） | MARK_TIME 4（弾を当てた敵が、味方全員のミニマップに映る秒数。当てるたびにこの長さに戻る。消耗戦・TD 共通） |
| アレックス（オーバードライブ） | INJECT_TIME 0.4（注射の動作。この間は撃てない）、DURATION 6、SPEED_MUL 1.3（移動速度の倍率）、REGEN_MUL 2（回復の速さの倍率。効果中はダメージを受けた直後でも回復する） | SPEED_MUL 1.1（常に移動速度がこの倍率） |
| 蘭丸（フェイズシフト） | WINDUP 0.5（準備の秒数）、DURATION 3（無敵の秒数）、SPEED_MUL 1.3（その間の移動速度の倍率）。準備中から終わるまで、撃つ・投げる・殴る・エイム・アビリティはできない | （数値なし）タレットなどに狙われると画面の縁が紫に光り、警告音が鳴る |


## タイムアタック（timeattack.json）

| 項目 | 値 | 意味 |
|---|---|---|
| COUNTDOWN | 3 | スタート前のカウントダウン（秒）。この間は動けない（見回すことはできる） |
| MISS_PENALTY | 5 | 壊し損ねたターゲット1体ごとに足される秒数 |
| RESTART_HOLD | 0.7 | R キーをこの秒数押し続けると、スタートからやり直す（短く押すとリロード） |
| CHECKPOINT_RADIUS | 3.5 | チェックポイントを通ったとみなす半径（m） |
| CHECKPOINT_HEIGHT | 4 | チェックポイントを通ったとみなす高さの幅（上下 m） |
| TARGET_HEALTH | 60 | 立っている的・動く的の体力 |
| DRONE_HEALTH | 40 | 浮いているドローンの体力 |
| GHOST_INTERVAL_TICKS | 2 | ゴーストを記録する間隔（ティック。60 で割ると秒） |

## 消耗戦（attrition.json）

| 名前 | 初期値 | 意味 |
|---|---|---|
| SCORE_LIMIT | 300 | 目標スコア。先に届いたチームの勝ち |
| TIME_LIMIT | 600 | 制限時間（秒）。時間切れのときは点の多いチームの勝ち（同点は引き分け） |
| TEAM_SIZE | 6 | 1チームのパイロットの数（プレイヤーを含む） |
| INTRO_TIME | 4 | 試合開始までのカウントダウン（この間は動けない。見回すことはできる） |
| END_DELAY | 3 | 試合が終わってからリザルトを出すまで |
| RESPAWN_TIME | 5 | 倒されてから復活するまで |
| SPAWN_INVULN | 2 | 復活直後の無敵の時間 |
| SPAWN_ENEMY_AVOID | 28 | 出現地点を選ぶとき、敵がこの距離より近い地点は大きく避ける |
| PILOT_KILL_SCORE | 5 | 敵パイロットを倒したときの得点 |
| GRUNT_KILL_SCORE | 1 | 敵の歩兵を倒したときの得点 |
| ASSIST_SCORE | 1 | アシスト（倒された敵パイロットに、直前 ASSIST_WINDOW 秒以内にダメージを与えていた）の得点 |
| ASSIST_WINDOW | 5 | アシストになる時間 |
| GRUNT_MAX | 12 | 1チームの歩兵の最大数 |
| GRUNT_SQUAD | 4 | 1回に湧く歩兵の分隊の人数 |
| GRUNT_SPAWN_INTERVAL | 14 | 歩兵の分隊が湧く間隔（秒。最大数に届いていれば湧かない） |
| GRUNT_FIRST_DELAY | 2 | 試合開始から最初の分隊が湧くまで |

## 消耗戦のブースト（boosts.json）

得点（attrition.json の PILOT_KILL_SCORE など）がそのままゲージにたまり、COST に届くと X キーで使える。

| 名前 | 初期値 | 意味 |
|---|---|---|
| STREAK_BONUS | 0.25 | 倒されずにパイロットを続けて倒したとき、2 体目から 1 体ごとに増える、たまる量の割合 |
| STREAK_BONUS_MAX | 1.0 | その増え方の上限（1.0 ＝ 2 倍まで） |

BOOSTS には各ブーストを並べる。どれにも NAME（名前）・SHORT（英語の短い名前）・DESC（説明）・COST（満タンに要る得点）がある。

| ブースト | 項目（初期値） |
|---|---|
| maphack（マップハック） | COST 30、DURATION 15（続く秒）、PULSE 1.5（敵の位置を映す間隔） |
| holopilot（ホロパイロット） | COST 25、COUNT 5（体数）、DURATION 9（走る秒）、SPREAD 80（前へ扇状に広がる角度） |
| phaserewind（フェイズリワインド） | COST 25、REWIND 5（何秒前の場所へ戻るか）、TRAVEL 0.6（戻るのにかかる秒） |
| hardcover（ハードカバー） | COST 30、WIDTH 6・HEIGHT 2.8（盾の大きさ m）、DISTANCE 2.2（立てる距離）、DURATION 20（立っている秒） |
| ticks（ティック） | COST 35、COUNT 2（数）、THROW_SPEED 13（投げる速さ）、SPEED 7.5（這う速さ m/s）、SEEK_RANGE 28（見えている敵を狙う距離）、CHASE_RANGE 20（見えていなくても気づいて追いかける距離）、HEALTH 45（体力。撃って壊せる。当たり判定は爆弾兵と同じ）、TRIGGER 2.2（爆発する近さ）、DAMAGE 110・MIN_DAMAGE 30（真ん中・縁のダメージ）、RADIUS 4（範囲）、LIFE 12（自爆までの秒） |
| diceroll（ダイスロール） | COST 20（ほかの 5 つのどれかが出る） |

## タワーディフェンス（td.json）

### 進行・クレジット

| 名前 | 初期値 | 意味 |
|---|---|---|
| INTRO_TIME | 5 | 始まってから最初の準備時間までの時間 |
| PREP_TIME | 30 | 各ウェーブの前の準備時間（全員が準備完了なら飛ばす） |
| END_DELAY | 4 | 勝敗が決まってからリザルトを出すまで |
| CORE_HEALTH | 8000 | コアの体力 |
| START_CREDITS | 600 | はじめのクレジット（1人ずつ） |
| WAVE_BONUS / WAVE_BONUS_PER_WAVE | 200 / 40 | ウェーブを守りきったときに全員に入るクレジット（ウェーブが進むごとに 40 ずつ増える） |
| TURRET_LIMIT | 4 | 1人（ボットも）が置けるタレットの数 |
| SELL_REFUND | 0.5 | 売ったときに戻る割合 |
| PLACE_RANGE | 7 | タレットを置ける、自分からの距離 |
| PLACE_GAP | 2.4 | タレットどうしの最小の間隔 |
| SELL_HOLD | 0.8 | 売るときに E を押し続ける時間 |
| TURRET_ARMOR | 0.6 | タレットが受ける銃弾のダメージの倍率（爆発はそのまま） |
| MAX_ALIVE | 56 | 同時にいる敵の上限（降りてきている途中の降下ポッドの中の敵も数える。超える分は空きができるまで待つ） |
| HEALTH_PER_WAVE | 0.05 | ウェーブが1つ進むごとに増える、敵の体力の割合 |
| CORE_ALERT_TIME | 3 | コアが撃たれてから「攻撃されている」とみなす時間（ボットがコアを守りに行く） |

### ダウンと蘇生

| 名前 | 初期値 | 意味 |
|---|---|---|
| DOWN_TIME | 10 | ダウンしてから倒れるまで（この間に蘇生できる） |
| REVIVE_TIME | 3 | 蘇生に E を押し続ける時間 |
| REVIVE_RANGE | 2.2 | 蘇生できる距離 |
| REVIVE_HEALTH | 0.5 | 蘇生したときの体力の割合 |
| RESPAWN_TIME | 15 | ダウンしてから、要塞の中で復活するまで |

### 敵（ENEMIES）
共通：NAME（名前）・DESC（説明）・HEALTH（体力）・REWARD（倒したときのクレジット）。

| 敵 | 体力 | 主な項目 |
|---|---|---|
| grunt（歩兵） | 100 | SPEED_MUL 0.85（歩く速さの倍率）、DAMAGE_MUL 0.3（与えるダメージの倍率）、ENGAGE_RANGE 24（撃ち始める距離）、REWARD 8 |
| assault（爆弾兵） | 70 | SPEED_MUL 1.12、EXPLODE_RANGE 4.2（コアの表面からこの距離で自爆）、EXPLODE_CORE_DAMAGE 110（コアへのダメージ）、EXPLODE_RADIUS 5.5・EXPLODE_DAMAGE 70（まわりへの爆風）、REWARD 12 |
| heavy（重装兵） | 450 | SPEED_MUL 0.62、DAMAGE_MUL 0.32、ENGAGE_RANGE 34、REWARD 35。正面の盾は弾を止め、頭と背中の動力パックが弱点 |
| mortar（迫撃砲兵） | 150 | SPEED_MUL 0.82、DAMAGE_MUL 0.2（拳銃）、ENGAGE_RANGE 20（拳銃で撃ち返す距離）、PANIC_RANGE 11（据えたあと、この距離にパイロットが来ると砲撃をやめて応戦する）、SETUP_TIME 4（据えてから最初に撃つまで）、FIRE_INTERVAL 8（砲撃の間隔。±15%）、SHELL_CORE_DAMAGE 14（コアへのダメージ）、CORE_REACH 7.5（コアの中心からこの距離までの爆発がコアに届く。5m より遠いと減って、端で半分）、SHELL_RADIUS 4.5・SHELL_DAMAGE 45・SHELL_TURRET_MUL 0.5（まわりの味方への爆風。タレット・設置物への倍率）、SHELL_GRAVITY 18・SHELL_APEX 14・SHELL_APEX_PER_M 0.18（砲弾の重力と、頂点の高さ＝14m＋距離×0.18）、AIM_SIDE 6.5（狙う所：コアの南・北の脇のコアの中心からの距離。真上は連絡橋の屋根）、SPREAD 1.5・SPREAD_PER_M 0.02（ばらつきの半径＝1.5m＋距離×0.02）、MIN_RANGE 25・MAX_RANGE 125（射程）、GIVE_UP 50（降りてからこの秒数たっても据える所に着かなければ、射程の中で経路の点の近くならその場に据える）、REWARD 30 |
| drone（ドローン） | 160 | SPEED 9（飛ぶ速さ m/s）、DAMAGE_MUL 0.38、FIRE_RANGE 28（コアを撃つ距離）、REWARD 20 |
| boss（大型兵器） | 7000 | SPEED 1.9、STOP_DIST 24（コアのこの距離で止まる）、ROCKET_INTERVAL 3.4・ROCKET_COUNT 4（ロケットの間隔と1回の数）、ROCKET_DAMAGE 70・ROCKET_RADIUS 4.5・ROCKET_SPEED 26・ROCKET_RANGE 55、MG_DAMAGE_MUL 0.25・MG_RANGE 32（機銃）、REWARD 400 |

### タレット（TURRETS）
共通：NAME・DESC・COST（値段）・HEALTH（体力）。

| タレット | 値段 | 体力 | 主な項目 |
|---|---|---|---|
| mg（機銃） | 300 | 600 | RANGE 30、FIRE_INTERVAL 0.14（秒）、DAMAGE 8、SPREAD 3（度）、TURN_SPEED 220（度/秒）、AIR true（ドローンも撃つ） |
| rocket（ロケット） | 600 | 600 | RANGE 44、FIRE_INTERVAL 3、DAMAGE 120（中心）〜MIN_DAMAGE 30（端）、RADIUS 4、ROCKET_SPEED 38、TURN_SPEED 120、AIR false |
| slow（減速フィールド） | 400 | 500 | RADIUS 9、SLOW 0.5（範囲の敵の速さの倍率） |
| repair（修理ステーション） | 500 | 500 | RADIUS 12、TURRET_RATE 18（タレットを直す速さ /秒）、CORE_RATE 10（コア） |

### 購入メニューのアイテム（ITEMS）
共通：NAME・SHORT（カードの小さな見出し）・DESC・COST（値段）・LIMIT（1人が同時に持てる数。アーマーは 1 ラウンドに買える回数）。売ると COST × SELL_REFUND が戻る。

| アイテム | 値段 | 数 | 主な項目 |
|---|---|---|---|
| decoy（ダミーバルーン） | 150 | 2 | HEALTH 320、ASSAULT_LURE 14（この距離の爆弾兵を引きつけて、囮で自爆させる） |
| wiretrap（ワイヤートラップ） | 250 | 2 | SPAN 3.6（中央から左右の機雷までの最大の距離 m）、BEAM_HEIGHT 0.62（レーザーの高さ）、ARM_TIME 1.1（置いてから効くまで 秒）、DAMAGE 130〜MIN_DAMAGE 35（機雷1つの爆発。中心〜端）、RADIUS 4.2、CHAIN_DELAY 0.16（機雷が順に爆発する間隔） |
| barricade（バリケード） | 200 | 2 | HEALTH 1200、WIDTH 4.2・HEIGHT 1.25（m）、ARMOR 0.5（銃弾のダメージの倍率）、ASSAULT_MUL 2.5（爆弾兵の自爆がバリケードに与えるダメージの倍率） |
| jumppad（ジャンプパッド） | 120 | 2 | LAUNCH_UP 14.5（上向きの速さ m/s。高さはおよそ LAUNCH_UP² ÷ 36）、LAUNCH_FORWARD 4.5（進む向きへ足す速さ）、RADIUS 1.05（乗ったとみなす範囲）、COOLDOWN 0.8（同じ人を続けて跳ばさない秒） |
| armor（アーマー） | 200 | 1 | AMOUNT 50（体力の上に付く装甲。ダメージは先に装甲が受ける。ウェーブが終わると無くなる） |

### タレットの強化（UPGRADE）
レベルは 1〜MAX_LEVEL（3）。配列はレベルの順（1, 2, 3）。
- COST_MUL：レベル 2・3 へ上げる値段（タレットの COST に掛け、10 単位に丸める。機銃なら 180・270）
- DAMAGE_MUL・HEALTH_MUL・RANGE_MUL・INTERVAL_MUL（撃つ間隔の倍率。小さいほど速い）：機銃・ロケット。BLAST_MUL はロケットの爆発の範囲
- RADIUS_MUL：減速フィールド・修理ステーションの範囲。SLOW：減速フィールドの速さの倍率（0.5 → 0.4 → 0.32）。REPAIR_MUL：修理の速さ
- HEALTH_MUL は全部のタレットに効く（上げたとき、増えた分だけ体力も回復する）

### 難易度・人数・ウェーブ
- DIFFICULTY：難易度ごとの敵の体力・与えるダメージ・数の倍率（易 0.8・0.7・0.85、普 1・1・1、難 1.1・1.15・1.0）。味方のボット（人間が足りない枠の穴埋め）はいつも「普」の腕前
- ENEMY_AIM：難易度ごとの敵の狙いの腕前（項目の意味は bots.json と同じ）
- PLAYER_SCALE：参加人数（1〜4）ごとの敵の数・体力の倍率。いまは常に4人（プレイヤー＋ボット3体）。将来のオンライン用
- WAVES：10 ウェーブの中身。`groups` に、敵の種類（type）・数（count）・ルート（route：front / left / right）・出始めるまでの秒（delay）・1回に出る数（squad）・次までの間隔（interval）・降下ポッドの降りる場所（drop）を並べる。大型兵器は第5・第10ウェーブ
  - drop（地上の敵だけ）：降下地点の id（`wall_w`・`roof_e`・`yard_sw` など。shared/levels/fortress.ts の `dropZones`）か、種類（`outer` 外の草原・岩場／`wall` 防壁の上・屋上・テラス／`inner` 要塞の中）。種類のときは、準備時間の始めにそのルートの方面の同じ種類の降下地点から1つ選ぶ。書かなければ、そのルートの遠くの草原
  - 1回に出る数（squad）が、1つの降下ポッドに乗る数（POD.SIZE 4 体まで。多ければポッドを分ける）

### 降下ポッド（POD）

| 名前 | 初期値 | 意味 |
|---|---|---|
| POD.WARN | 3.2 | 降りる場所がわかってから着地するまで（秒。地面の輪・光の柱・ミニマップ・知らせ） |
| POD.OPEN | 0.8 | 着地してから扉が開いて分隊が出てくるまで |
| POD.LEAVE | 5.0 | 着地してから飛び去るまで（そのあいだは当たり判定がある） |
| POD.IMPACT_RADIUS / IMPACT_DAMAGE / IMPACT_PUSH | 3.6 / 60 / 11 | 着地の衝撃の範囲（m）・味方へのダメージ（真ん中。端は半分）・吹き飛ばす速さ |
| POD.CLEARANCE | 4.0 | タレットからこれだけ離れた所に降りる（設置物はこれより 1m 近くまで） |
| POD.SIZE | 4 | 1つのポッドに乗る敵の数 |

迫撃砲兵の据える所（前哨陣地の屋上・砲撃陣地・テラス・防壁の上など）は、マップのデータ（shared/levels/fortress.ts の `mortarSpots`）にある。`area` が `outer` の所は外に降りた迫撃砲兵、`inner` の所は防壁の上・要塞の中に降りた迫撃砲兵が使う。

## ボット（bots.json）

`easy`（易）・`normal`（普）・`hard`（難）がパイロットのボット、`GRUNT` が歩兵。難易度はキャラクター・装備の選択画面で選ぶ（味方・敵の両方に同じ難易度を使う）。

| 名前 | 易 / 普 / 難 | 意味 |
|---|---|---|
| REACTION | 0.75 / 0.55 / 0.25 | 敵が見えてから撃ち始めるまでの時間（秒） |
| AIM_ERROR | 7.0 / 5.0 / 3.2 | 狙い始めたときの照準のずれ（度） |
| AIM_ERROR_MIN | 3.6 / 2.4 / 0.7 | 狙い続けて落ち着いたときの照準のずれ（度） |
| AIM_SETTLE | 1.6 / 1.2 / 0.8 | ずれが小さくなるまでの時間（秒） |
| AIM_SPEED_PENALTY | 0.9 / 0.8 / 0.6 | 速く動く相手ほど照準のずれが増える（相手が 10m/s で動くと、ずれが 1＋この値 倍。16m/s で頭打ち）。走り続ける相手ほど当たりにくくなる |
| AIM_RANGE_PENALTY | 0.8 / 0.7 / 0.6 | 遠い相手ほど照準のずれが増える（25m から増え始め、50m で 1＋この値 倍、75m で頭打ち） |
| TURN_SPEED | 240 / 360 / 540 | 振り向きの速さの上限（度/秒） |
| BURST / PAUSE | 0.45・0.85 / 0.6・0.7 / 1.3・0.25 | 連射の武器で、撃ち続ける時間と休む時間（指切り射撃） |
| VIEW_RANGE | 55 / 65 / 80 | 敵が見える距離（光学迷彩の敵は 8m） |
| FOV | 100 / 120 / 140 | 見える範囲の角度（5m 以内と、撃ってきた相手は範囲の外でも気づく） |
| ABILITY_CHANCE | 0.45 / 0.75 / 1.0 | アビリティを使う場面で、実際に使う確率 |
| GRENADE_CHANCE | 0.08 / 0.15 / 0.25 | グレネードを投げるおおよその頻度（1秒あたり） |
| STRAFE | 0.5 / 0.8 / 1.0 | 撃ち合いの動きの激しさ（横の動き・2段ジャンプ・壁走り） |
| RETREAT_HEALTH | 0.4 / 0.45 / 0.45 | 体力がこの割合より減って撃たれていると、退避する |

歩兵（GRUNT）：HEALTH（体力 40）、DAMAGE_MUL（与えるダメージの倍率 0.32。アサルトライフルで 1発 8）、AIM_SPEED_PENALTY 0.6・AIM_RANGE_PENALTY 0.5、そのほかはパイロットと同じ意味の項目（照準のずれが大きく、反応が遅い）。
