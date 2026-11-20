import math
from PIL import Image, ImageDraw, ImageFilter, ImageFont

def create_portassist_icon():
    S = 1024
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Background Rounded Squircle with outer shadow
    pad = 72
    rad = 210
    
    # Outer glow / shadow
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle([pad-10, pad-6, S-pad+10, S-pad+14], radius=rad+8, fill=(0, 0, 0, 140))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    img = Image.alpha_composite(img, shadow)
    draw = ImageDraw.Draw(img)

    # Base gradient squircle: Dark futuristic slate-blue
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S-pad, S-pad], radius=rad, fill=255)

    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(base)
    for y in range(pad, S-pad):
        t = (y - pad) / (S - 2 * pad)
        # Gradient: Deep Cyan-Navy #0B192C to #070D14
        r = int(14 * (1 - t) + 8 * t)
        g = int(28 * (1 - t) + 14 * t)
        b = int(46 * (1 - t) + 24 * t)
        bdraw.line([(pad, y), (S-pad, y)], fill=(r, g, b, 255))
    
    # Border stroke with cyan-teal glow gradient
    stroke_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    stdraw = ImageDraw.Draw(stroke_layer)
    for y in range(pad, S-pad):
        t = (y - pad) / (S - 2 * pad)
        # Top cyan #38bdf8 to bottom indigo-blue #3b82f6
        r = int(56 * (1 - t) + 37 * t)
        g = int(189 * (1 - t) + 99 * t)
        b = int(248 * (1 - t) + 235 * t)
        stdraw.line([(pad, y), (S-pad, y)], fill=(r, g, b, int(220 * (1 - t * 0.4))))
    
    stroke_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(stroke_mask).rounded_rectangle([pad, pad, S-pad, S-pad], radius=rad, fill=255)
    inner_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(inner_mask).rounded_rectangle([pad+10, pad+10, S-pad-10, S-pad-10], radius=rad-6, fill=255)
    
    # Subtract inner from stroke
    from PIL import ImageChops
    stroke_border = ImageChops.subtract(stroke_mask, inner_mask)
    
    # Composite base and stroke
    img.paste(base, (0, 0), mask)
    img.paste(stroke_layer, (0, 0), stroke_border)
    draw = ImageDraw.Draw(img)

    # 2. Central motif: Stylized DB9 serial connector + pulse signals
    # DB9 D-sub shape: Trapezoid
    cx, cy = S // 2, S // 2 - 20
    w_top, w_bot = 480, 400
    h = 290
    top_y = cy - h // 2
    bot_y = cy + h // 2
    
    # Trapezoid coordinates
    dsub_poly = [
        (cx - w_top // 2, top_y),
        (cx + w_top // 2, top_y),
        (cx + w_bot // 2, bot_y),
        (cx - w_bot // 2, bot_y),
    ]

    # Metallic shell for DB9
    shell_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sh_draw = ImageDraw.Draw(shell_layer)
    sh_draw.polygon(dsub_poly, fill=(30, 41, 59, 255), outline=(100, 116, 139, 255))
    img = Image.alpha_composite(img, shell_layer)

    # Inner recessed plug area (smaller trapezoid)
    iw_top, iw_bot = 420, 345
    ih = 230
    itop_y = cy - ih // 2
    ibot_y = cy + ih // 2
    inner_dsub = [
        (cx - iw_top // 2, itop_y),
        (cx + iw_top // 2, itop_y),
        (cx + iw_bot // 2, ibot_y),
        (cx - iw_bot // 2, ibot_y),
    ]
    recess = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    r_draw = ImageDraw.Draw(recess)
    r_draw.polygon(inner_dsub, fill=(15, 23, 42, 255), outline=(14, 165, 233, 220))
    img = Image.alpha_composite(img, recess)
    draw = ImageDraw.Draw(img)

    # Draw DB9 pins (5 top row, 4 bottom row) with glowing pins
    top_pins_y = cy - 44
    bot_pins_y = cy + 44
    pin_rad = 18

    # Glowing pins
    top_xs = [cx - 150, cx - 75, cx, cx + 75, cx + 150]
    bot_xs = [cx - 112, cx - 37, cx + 37, cx + 112]

    # Pin glow
    glow_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    g_draw = ImageDraw.Draw(glow_layer)

    for px in top_xs:
        # Amber/Cyan pins (active signals TX/RX)
        g_draw.ellipse([px - pin_rad*1.8, top_pins_y - pin_rad*1.8, px + pin_rad*1.8, top_pins_y + pin_rad*1.8], fill=(56, 189, 248, 120))
    for px in bot_xs:
        g_draw.ellipse([px - pin_rad*1.8, bot_pins_y - pin_rad*1.8, px + pin_rad*1.8, bot_pins_y + pin_rad*1.8], fill=(16, 185, 129, 110))
    
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(10))
    img = Image.alpha_composite(img, glow_layer)
    draw = ImageDraw.Draw(img)

    # Solid pins (gold/cyan contacts)
    for i, px in enumerate(top_xs):
        # Center pin gold, outer cyan
        col = (56, 189, 248, 255) if i != 2 else (245, 158, 11, 255)
        rim = (255, 255, 255, 240)
        draw.ellipse([px - pin_rad, top_pins_y - pin_rad, px + pin_rad, top_pins_y + pin_rad], fill=col, outline=rim, width=3)
    for i, px in enumerate(bot_xs):
        col = (52, 211, 153, 255) if i in (1, 2) else (56, 189, 248, 255)
        rim = (255, 255, 255, 240)
        draw.ellipse([px - pin_rad, bot_pins_y - pin_rad, px + pin_rad, bot_pins_y + pin_rad], fill=col, outline=rim, width=3)

    # 3. Dynamic communication wave pulses (CAN / Network data stream) below the connector
    wave_y = cy + 220
    # Left & right radiating digital wave bars
    wave_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    w_draw = ImageDraw.Draw(wave_layer)
    
    bars = [
        (-220, 28, (56, 189, 248, 160)),
        (-170, 48, (56, 189, 248, 210)),
        (-120, 72, (56, 189, 248, 240)),
        (-70, 96, (14, 165, 233, 255)),
        (-20, 115, (52, 211, 153, 255)),
        (20, 115, (52, 211, 153, 255)),
        (70, 96, (14, 165, 233, 255)),
        (120, 72, (56, 189, 248, 240)),
        (170, 48, (56, 189, 248, 210)),
        (220, 28, (56, 189, 248, 160)),
    ]
    for ox, bh, col in bars:
        bx = cx + ox
        w_draw.rounded_rectangle([bx - 12, wave_y - bh//2, bx + 12, wave_y + bh//2], radius=6, fill=col)

    # Connecting bus horizontal line
    w_draw.line([(cx - 280, wave_y), (cx + 280, wave_y)], fill=(56, 189, 248, 90), width=4)
    img = Image.alpha_composite(img, wave_layer)
    draw = ImageDraw.Draw(img)

    # 4. Modern Badge: "PORT ASSIST" or "PA" text banner at top / bottom
    # Sleek bottom label
    banner_y = S - pad - 120
    font = None
    try:
        font = ImageFont.truetype("arialbd.ttf", 60)
    except:
        font = ImageFont.load_default()

    label = "PORT-ASSIST"
    bbox = draw.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (S - tw) // 2
    
    # Subtle dark pill behind text
    draw.rounded_rectangle([tx - 28, banner_y - 12, tx + tw + 28, banner_y + th + 16], radius=18, fill=(15, 23, 42, 200), outline=(56, 189, 248, 180), width=2)
    draw.text((tx, banner_y - 2), label, font=font, fill=(240, 249, 255, 255))

    return img

if __name__ == "__main__":
    icon = create_portassist_icon()
    icon.save("src-tauri/icons/icon.png")
    
    # Save multi-size ICO
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    icon.save("src-tauri/icons/icon.ico", format="ICO", sizes=sizes)

    # Also save ui/favicon.png and ui/favicon.ico
    icon.resize((64, 64), Image.Resampling.LANCZOS).save("ui/favicon.png")
    icon.save("ui/favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("PortAssist icons generated successfully!")
