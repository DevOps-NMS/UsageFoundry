#!/usr/bin/env python3
"""Compute WCAG 2.x contrast ratios for every colour pair src/app/globals.css
declares, so the numbers in 00-problem.md are reproducible rather than asserted.

Run from the repository root:

    python3 proposals/OperatorInterface/contrast.py

The token values below are transcribed from `src/app/globals.css:50-160`. They
are a copy, not a read, and that is the one thing here that can go stale: if a
token moves, this file is wrong and says nothing about it. Re-transcribe before
trusting a re-run, and diff against `git log -p -- src/app/globals.css`.

Two pieces of arithmetic are worth stating because getting either wrong changes
every number that depends on it.

`color-mix(in oklab, C 45%, transparent)` is C at alpha 0.45. CSS Color 5 mixes
premultiplied, and `transparent` is `rgb(0 0 0 / 0)`, so the colour components
survive the mix untouched and only the alpha moves. Painting that over a surface
is then a straight sRGB composite, because that is what a browser compositor
does. So `--ring` is `--accent` at 45% over whatever is behind it.

`color-mix(in oklab, C 40%, var(--border))` is a mix of two *opaque* colours and
is interpolated in Oklab, which is not sRGB and not close enough to fake. The
tone lines are computed through a real Oklab round trip below.
"""

# --- sRGB, relative luminance, ratio -------------------------------------

def _lin(c8):
    c = c8 / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _rgb(hexs):
    h = hexs.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(min(255, max(0, int(round(c)))) for c in rgb)


def lum(hexs):
    r, g, b = _rgb(hexs)
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def over(fg, bg, alpha):
    """Composite `fg` at `alpha` over opaque `bg`, in sRGB, as a compositor does."""
    f, b = _rgb(fg), _rgb(bg)
    return _hex([alpha * f[i] + (1 - alpha) * b[i] for i in range(3)])


# --- Oklab, for color-mix(in oklab, ...) between two opaque colours -------

def _srgb_to_linear(c8):
    return _lin(c8)


def _linear_to_srgb(c):
    c = max(0.0, min(1.0, c))
    s = c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return s * 255


def to_oklab(hexs):
    r, g, b = (_srgb_to_linear(v) for v in _rgb(hexs))
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = l ** (1 / 3) if l > 0 else 0, m ** (1 / 3) if m > 0 else 0, s ** (1 / 3) if s > 0 else 0
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def from_oklab(lab):
    L, a, b = lab
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return _hex([_linear_to_srgb(r), _linear_to_srgb(g), _linear_to_srgb(bb)])


def mix_oklab(a, b, frac_a):
    la, lb = to_oklab(a), to_oklab(b)
    return from_oklab(tuple(frac_a * la[i] + (1 - frac_a) * lb[i] for i in range(3)))


# --- the tokens, transcribed from src/app/globals.css:50-160 --------------

LIGHT = {
    "bg": "#f0f0f3", "bg-raised": "#ffffff", "bg-inset": "#f5f5f7", "bg-grouped": "#f7f7f9",
    "border": "#e3e3e6", "border-strong": "#c7c7cc",
    "fg": "#1d1d1f", "fg-muted": "#68686d", "fg-faint": "#86868b",
    "accent": "#0069d9", "accent-dim": "#d6e4fa",
    "ok": "#177d33", "warn": "#8c5e00", "danger": "#d70015",
    "tint": "#0069d9", "tint-fg": "#ffffff",
    "bezel": "#ffffff", "bezel-hover": "#f2f2f4",
}

DARK = {
    "bg": "#1e1e20", "bg-raised": "#2a2a2d", "bg-inset": "#161618", "bg-grouped": "#323235",
    "border": "#3a3a3d", "border-strong": "#4d4d52",
    "fg": "#f5f5f7", "fg-muted": "#a1a1a6", "fg-faint": "#8a8a8f",
    "accent": "#4a9bff", "accent-dim": "#1f3a5f",
    "ok": "#30d158", "warn": "#ff9f0a", "danger": "#ff6961",
    "tint": "#0a6cd8", "tint-fg": "#ffffff",
    "bezel": "#48484c", "bezel-hover": "#545458",
}

SCHEMES = (("LIGHT", LIGHT), ("DARK", DARK))

TEXT = ["fg", "fg-muted", "fg-faint", "accent", "ok", "warn", "danger"]
SURFACE = ["bg", "bg-raised", "bg-inset", "bg-grouped", "bezel", "bezel-hover", "accent-dim"]


def band(r, threshold):
    return "PASS" if r >= threshold else "FAIL"


def main():
    for name, T in SCHEMES:
        print(f"\n=== {name}: text on surface (1.4.3 AA = 4.5, large text = 3, 1.4.6 AAA = 7) ===")
        print("            " + "".join(f"{s:>14}" for s in SURFACE))
        for f in TEXT:
            row = f"{f:>12}"
            for s in SURFACE:
                r = ratio(T[f], T[s])
                flag = "" if r >= 4.5 else ("*" if r >= 3 else "!!")
                row += f"{r:>11.2f}{flag:<3}"
            print(row)

    print("\n=== the focus ring: --ring = --accent at 45%, over each surface (1.4.11 = 3) ===")
    for name, T in SCHEMES:
        for s in ["bg", "bg-raised", "bg-inset", "bg-grouped"]:
            ring = over(T["accent"], T[s], 0.45)
            print(f"  {name.lower():>5}  {ring} on {s:<11} {ratio(ring, T[s]):>5.2f}"
                  f"  {band(ratio(ring, T[s]), 3)}")
    print("  and the danger ring, --danger at 45%:")
    for name, T in SCHEMES:
        for s in ["bg-raised", "bg-inset"]:
            ring = over(T["danger"], T[s], 0.45)
            print(f"  {name.lower():>5}  {ring} on {s:<11} {ratio(ring, T[s]):>5.2f}"
                  f"  {band(ratio(ring, T[s]), 3)}")

    print("\n=== a hovered and a pressed row: --fill-hover (fg 8%) / --fill-active (fg 14%) ===")
    for name, T in SCHEMES:
        for s in ["bg", "bg-raised", "bg-inset"]:
            h = over(T["fg"], T[s], 0.08)
            a = over(T["fg"], T[s], 0.14)
            print(f"  {name.lower():>5}  on {s:<11} hover {h}"
                  f" muted={ratio(T['fg-muted'], h):.2f} faint={ratio(T['fg-faint'], h):.2f}"
                  f" | active {a} muted={ratio(T['fg-muted'], a):.2f}"
                  f" faint={ratio(T['fg-faint'], a):.2f}")

    print("\n=== a white label on a tone fill (1.4.3 AA = 4.5) ===")
    for name, T in SCHEMES:
        for tone in ["tint", "danger", "ok", "warn", "accent"]:
            r = ratio("#ffffff", T[tone])
            print(f"  {name.lower():>5}  #ffffff on --{tone:<8} {r:>5.2f}  {band(r, 4.5)}")

    print("\n=== the tone lines, mixed in Oklab against --border, on a card (1.4.11 = 3) ===")
    for name, T in SCHEMES:
        for tone in ["ok", "warn", "danger", "accent"]:
            line = mix_oklab(T[tone], T["border"], 0.40)
            for s in ["bg-raised", "bg-inset"]:
                r = ratio(line, T[s])
                print(f"  {name.lower():>5}  --{tone}-line {line} on {s:<11} {r:>5.2f}  {band(r, 3)}")

    print("\n=== a hairline as a boundary (1.4.11 = 3; a decorative edge is exempt) ===")
    for name, T in SCHEMES:
        for edge in ["border", "border-strong"]:
            for s in ["bg", "bg-raised", "bg-inset"]:
                r = ratio(T[edge], T[s])
                print(f"  {name.lower():>5}  --{edge:<13} on {s:<11} {r:>5.2f}  {band(r, 3)}")


if __name__ == "__main__":
    main()
