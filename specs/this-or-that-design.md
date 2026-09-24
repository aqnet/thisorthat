# This or That — Design System

Status: v0.1, covering themes, color, and type. Game mechanics come next.

---

## 1. Core principles

1. **Side A is warm and Side B is cool, in every theme and mode.** Players learn this mapping in one round, so it never changes.
2. **Both sides have equal visual weight.** Match A and B on perceived lightness and saturation so neither color pulls votes. Randomize which option appears on which side.
3. **No red vs. green.** It implies right or wrong and fails for players with red-green color blindness.
4. **A third color belongs to neither side.** The `spark` color is reserved for the "or" badge, timers, streaks, and reveals. Never use Side A or Side B colors for chrome.
5. **Components never reference a theme.** Components read semantic tokens only. A theme is a set of values for those tokens.
6. **Display fonts are for options only.** Questions and any text longer than a few words use the body font.

---

## 2. Theming architecture

Theming has two independent settings:

| Setting | Options | Notes |
|---|---|---|
| **Theme** | Duel, Candy pop (extensible) | Controls color, type, radius, layout variant, and motion |
| **Mode** | Light, dark, system | Every theme must ship both a light and a dark value set |

- Adding a theme means adding one token file. No component changes are needed.
- Layout is limited to named variants that the choice component supports: `split` and `cards`. Themes pick a variant and never define custom layouts.
- The settings picker shows a live preview of the choice card for each theme, not just theme names.
- The theme is saved per device. On a shared screen, the host's screen uses its own theme, and each player's phone keeps its own choice.

---

## 3. Token structure

| Group | Tokens |
|---|---|
| Side A | `side-a-fill`, `side-a-tint`, `on-side-a` |
| Side B | `side-b-fill`, `side-b-tint`, `on-side-b` |
| Neutral | `bg`, `surface`, `ink`, `ink-muted` |
| Spark | `spark`, `on-spark` |
| Feedback | `majority`, `minority`, `tie` (never tied to A or B) |
| Type | `font-display`, `font-body`, `font-numeric`, `display-min-size` |
| Shape | `radius-card`, `radius-control`, `layout-variant` |
| Motion | `motion-select`, `motion-reveal` |

---

## 4. Themes

### Duel

Bold and poster-like, with versus energy. Uses an edge-to-edge split with a center "or" badge.

**Light**

| Token | Value |
|---|---|
| `side-a-fill` | `#FF5A4E` coral |
| `side-b-fill` | `#2F5BFF` cobalt |
| `on-side-a` / `on-side-b` | `#FFFFFF` |
| `spark` | `#FFD23F` yellow |
| `ink` | `#141414` |
| `bg` | `#FFF8F0` |

**Dark** (formerly the Neon arcade direction)

| Token | Value |
|---|---|
| `side-a-fill` | `#FF2E88` magenta |
| `side-b-fill` | `#00E5FF` cyan |
| `spark` | `#C6FF00` lime |
| `ink` | `#F2F0FF` |
| `bg` | `#0D0B1A` |

**Shape and motion**

| Token | Value |
|---|---|
| `layout-variant` | `split` |
| `radius-card` | 10px |
| Motion | Snap and slam. Animate the display font's weight on hover and select. |

### Candy pop

Rounded and playful. Uses two floating cards with a gap between them.

**Light**

| Token | Value |
|---|---|
| `side-a-fill` | `#FF9F1C` tangerine |
| `side-b-fill` | `#9B7BFF` lilac |
| `on-side-a` | `#4A2600` |
| `on-side-b` | `#221452` |
| `spark` | `#FF7AB6` bubblegum |
| `ink` | `#2B1B3D` |
| `bg` | `#FFF4E6` |

**Dark:** not yet defined. This is required before the theme ships.

**Shape and motion**

| Token | Value |
|---|---|
| `layout-variant` | `cards` |
| `radius-card` | 20px |
| Motion | Squish and overshoot |

---

## 5. Typography

All fonts use the SIL Open Font License and are self-hosted.

| Token | Duel | Candy pop |
|---|---|---|
| `font-display` | Big Shoulders Display, 800 (variable, 100–900) | Lilita One (single weight) |
| `font-body` | Archivo | Nunito |
| `font-numeric` | Archivo, tabular figures | Nunito, tabular figures |
| `display-min-size` | 18px | 20px |

**Rules**
- Display fonts are used only for option labels, titles, and the "or" badge.
- Lilita One has only one weight, so emphasis in Candy pop display text comes from size and color, not boldness.
- Vote percentages use tabular figures so the numbers don't jitter while they count up.
- Test option labels against the longest likely word, such as "MOUNTAINS." Label fitting is a system rule, not something to fix per question.

---

## 6. Open items

- [ ] Candy pop dark palette
- [ ] Lock values for tint and feedback tokens (`majority`, `minority`, `tie`)
- [ ] Contrast check for all fill and on-color pairs, WCAG AA or better
- [ ] Define the play context: solo swipe, one shared screen, multiplayer on phones, or team icebreaker. This drives game mechanics.
- [ ] Game mechanics
