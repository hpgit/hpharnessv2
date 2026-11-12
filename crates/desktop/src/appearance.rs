//! Native painting primitives and restrained desktop chrome shared by the workspace views.
use eframe::egui::{
    self, Color32, CornerRadius, FontId, Pos2, Rect, Response, Sense, Shape, Stroke, StrokeKind,
    TextFormat, TextStyle, Vec2,
};

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub enum Icon {
    Panel,
    NewChat,
    Search,
    Folder,
    ChevronDown,
    ChevronRight,
    Plus,
    Settings,
    Memory,
    Inbox,
    Code,
    Chat,
    Terminal,
    ArrowUp,
    Stop,
    Copy,
    Check,
    More,
    Close,
}

#[derive(Clone, Copy)]
pub struct Palette {
    pub canvas: Color32,
    pub sidebar: Color32,
    pub text: Color32,
    pub muted: Color32,
    pub border: Color32,
    pub hover: Color32,
    pub selected: Color32,
    pub input: Color32,
    pub bubble: Color32,
    pub accent: Color32,
}

pub fn palette(dark: bool, solarized: bool) -> Palette {
    if dark {
        Palette {
            canvas: Color32::from_rgb(30, 30, 30),
            sidebar: Color32::from_rgb(24, 24, 24),
            text: Color32::from_rgb(235, 235, 235),
            muted: Color32::from_rgb(161, 161, 161),
            border: Color32::from_rgb(59, 59, 59),
            hover: Color32::from_rgb(47, 47, 47),
            selected: Color32::from_rgb(57, 57, 57),
            input: Color32::from_rgb(38, 38, 38),
            bubble: Color32::from_rgb(46, 46, 46),
            accent: Color32::from_rgb(235, 235, 235),
        }
    } else if solarized {
        Palette {
            canvas: Color32::from_rgb(253, 246, 227),
            sidebar: Color32::from_rgb(238, 232, 213),
            text: Color32::from_rgb(7, 54, 66),
            muted: Color32::from_rgb(88, 110, 117),
            border: Color32::from_rgb(220, 216, 196),
            hover: Color32::from_rgb(229, 224, 203),
            selected: Color32::from_rgb(220, 215, 193),
            input: Color32::from_rgb(253, 248, 235),
            bubble: Color32::from_rgb(238, 232, 213),
            accent: Color32::from_rgb(7, 54, 66),
        }
    } else {
        Palette {
            canvas: Color32::WHITE,
            sidebar: Color32::from_rgb(247, 247, 247),
            text: Color32::from_rgb(35, 35, 35),
            muted: Color32::from_rgb(111, 111, 111),
            border: Color32::from_rgb(230, 230, 230),
            hover: Color32::from_rgb(237, 237, 237),
            selected: Color32::from_rgb(231, 231, 231),
            input: Color32::WHITE,
            bubble: Color32::from_rgb(244, 244, 244),
            accent: Color32::from_rgb(36, 36, 36),
        }
    }
}

pub fn apply(ctx: &egui::Context, dark: bool, solarized: bool) {
    let p = palette(dark, solarized);
    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };
    visuals.panel_fill = p.canvas;
    visuals.window_fill = p.canvas;
    visuals.extreme_bg_color = p.input;
    visuals.faint_bg_color = p.bubble;
    visuals.override_text_color = Some(p.text);
    visuals.weak_text_color = Some(p.muted);
    visuals.selection.bg_fill = p.selected;
    visuals.selection.stroke = Stroke::new(1.0_f32, p.text);
    visuals.hyperlink_color = if dark {
        Color32::from_rgb(150, 190, 230)
    } else {
        Color32::from_rgb(41, 100, 161)
    };
    visuals.window_corner_radius = CornerRadius::same(12);
    visuals.window_stroke = Stroke::new(1.0_f32, p.border);
    visuals.widgets.noninteractive.bg_fill = p.canvas;
    visuals.widgets.noninteractive.weak_bg_fill = Color32::TRANSPARENT;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, p.border);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, p.text);
    visuals.widgets.inactive.bg_fill = p.input;
    visuals.widgets.inactive.weak_bg_fill = Color32::TRANSPARENT;
    visuals.widgets.inactive.bg_stroke = Stroke::NONE;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, p.text);
    visuals.widgets.hovered.bg_fill = p.hover;
    visuals.widgets.hovered.weak_bg_fill = p.hover;
    visuals.widgets.hovered.bg_stroke = Stroke::NONE;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, p.text);
    visuals.widgets.active.bg_fill = p.selected;
    visuals.widgets.active.weak_bg_fill = p.selected;
    visuals.widgets.active.bg_stroke = Stroke::NONE;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, p.text);
    visuals.widgets.open.bg_fill = p.selected;
    visuals.widgets.open.weak_bg_fill = p.selected;
    visuals.widgets.open.bg_stroke = Stroke::NONE;
    visuals.widgets.open.fg_stroke = Stroke::new(1.0_f32, p.text);
    for widget in [
        &mut visuals.widgets.noninteractive,
        &mut visuals.widgets.inactive,
        &mut visuals.widgets.hovered,
        &mut visuals.widgets.active,
        &mut visuals.widgets.open,
    ] {
        widget.corner_radius = CornerRadius::same(10);
        widget.expansion = 0.0;
    }
    ctx.set_visuals(visuals);
    ctx.style_mut(|style| {
        style.spacing.item_spacing = Vec2::new(8.0, 8.0);
        style.spacing.button_padding = Vec2::new(10.0, 6.0);
        style.spacing.interact_size.y = 30.0;
        style.spacing.window_margin = egui::Margin::same(18);
        style.spacing.menu_margin = egui::Margin::same(6);
        style
            .text_styles
            .insert(TextStyle::Body, FontId::proportional(14.0));
        style
            .text_styles
            .insert(TextStyle::Button, FontId::proportional(13.0));
        style
            .text_styles
            .insert(TextStyle::Small, FontId::proportional(12.0));
        style
            .text_styles
            .insert(TextStyle::Heading, FontId::proportional(20.0));
        style
            .text_styles
            .insert(TextStyle::Monospace, FontId::monospace(13.0));
    });
}

fn paint_icon(painter: &egui::Painter, rect: Rect, icon: Icon, color: Color32) {
    let scale = rect.width().min(rect.height()) / 24.0;
    let at = |x: f32, y: f32| Pos2::new(rect.left() + x * scale, rect.top() + y * scale);
    let stroke = Stroke::new((1.55 * scale).max(1.0), color);
    let line = |points: &[(f32, f32)]| {
        painter.add(Shape::line(
            points.iter().map(|&(x, y)| at(x, y)).collect(),
            stroke,
        ));
    };
    let outline = |min: (f32, f32), max: (f32, f32), radius: u8| {
        painter.rect_stroke(
            Rect::from_min_max(at(min.0, min.1), at(max.0, max.1)),
            radius,
            stroke,
            StrokeKind::Inside,
        );
    };
    match icon {
        Icon::Panel => {
            outline((3.0, 4.0), (21.0, 20.0), 2);
            line(&[(9.0, 4.0), (9.0, 20.0)]);
        }
        Icon::NewChat => {
            line(&[
                (12.0, 4.0),
                (4.0, 4.0),
                (4.0, 20.0),
                (20.0, 20.0),
                (20.0, 12.0),
            ]);
            line(&[
                (10.0, 14.0),
                (11.0, 10.0),
                (18.0, 3.0),
                (21.0, 6.0),
                (14.0, 13.0),
                (10.0, 14.0),
            ]);
            line(&[(16.0, 5.0), (19.0, 8.0)]);
        }
        Icon::Search => {
            painter.circle_stroke(at(10.5, 10.5), 6.5 * scale, stroke);
            line(&[(15.5, 15.5), (21.0, 21.0)]);
        }
        Icon::Folder => {
            line(&[
                (3.0, 6.0),
                (9.0, 6.0),
                (11.0, 8.5),
                (21.0, 8.5),
                (21.0, 20.0),
                (3.0, 20.0),
                (3.0, 6.0),
            ]);
        }
        Icon::ChevronDown => line(&[(6.0, 9.0), (12.0, 15.0), (18.0, 9.0)]),
        Icon::ChevronRight => line(&[(9.0, 6.0), (15.0, 12.0), (9.0, 18.0)]),
        Icon::Plus => {
            line(&[(5.0, 12.0), (19.0, 12.0)]);
            line(&[(12.0, 5.0), (12.0, 19.0)]);
        }
        Icon::Settings => {
            painter.circle_stroke(at(12.0, 12.0), 6.5 * scale, stroke);
            painter.circle_stroke(at(12.0, 12.0), 2.5 * scale, stroke);
            for step in 0..8 {
                let angle = step as f32 * std::f32::consts::TAU / 8.0;
                let (s, c) = angle.sin_cos();
                line(&[
                    (12.0 + c * 6.5, 12.0 + s * 6.5),
                    (12.0 + c * 9.0, 12.0 + s * 9.0),
                ]);
            }
        }
        Icon::Memory => {
            line(&[
                (12.0, 6.0),
                (8.0, 4.0),
                (3.0, 4.0),
                (3.0, 18.0),
                (8.0, 18.0),
                (12.0, 20.0),
                (16.0, 18.0),
                (21.0, 18.0),
                (21.0, 4.0),
                (16.0, 4.0),
                (12.0, 6.0),
                (12.0, 20.0),
            ]);
        }
        Icon::Inbox => {
            line(&[
                (3.0, 10.0),
                (6.0, 4.0),
                (18.0, 4.0),
                (21.0, 10.0),
                (21.0, 20.0),
                (3.0, 20.0),
                (3.0, 10.0),
                (8.0, 10.0),
                (10.0, 13.0),
                (14.0, 13.0),
                (16.0, 10.0),
                (21.0, 10.0),
            ]);
        }
        Icon::Code => {
            line(&[(7.0, 6.0), (2.0, 12.0), (7.0, 18.0)]);
            line(&[(17.0, 6.0), (22.0, 12.0), (17.0, 18.0)]);
            line(&[(14.0, 3.0), (10.0, 21.0)]);
        }
        Icon::Chat => {
            outline((3.0, 4.0), (21.0, 18.0), 3);
            line(&[(7.0, 18.0), (7.0, 22.0), (12.0, 18.0)]);
        }
        Icon::Terminal => {
            outline((2.0, 4.0), (22.0, 20.0), 2);
            line(&[(6.0, 8.0), (10.0, 12.0), (6.0, 16.0)]);
            line(&[(13.0, 16.0), (18.0, 16.0)]);
        }
        Icon::ArrowUp => {
            line(&[(12.0, 20.0), (12.0, 4.0)]);
            line(&[(5.0, 11.0), (12.0, 4.0), (19.0, 11.0)]);
        }
        Icon::Stop => {
            outline((6.0, 6.0), (18.0, 18.0), 2);
        }
        Icon::Copy => {
            outline((8.0, 8.0), (21.0, 21.0), 2);
            line(&[
                (16.0, 5.0),
                (16.0, 3.0),
                (3.0, 3.0),
                (3.0, 16.0),
                (5.0, 16.0),
            ]);
        }
        Icon::Check => line(&[(4.0, 12.0), (9.0, 17.0), (20.0, 6.0)]),
        Icon::More => {
            for x in [5.0, 12.0, 19.0] {
                painter.circle_filled(at(x, 12.0), 1.35 * scale, color);
            }
        }
        Icon::Close => {
            line(&[(6.0, 6.0), (18.0, 18.0)]);
            line(&[(18.0, 6.0), (6.0, 18.0)]);
        }
    }
}

pub fn icon(ui: &mut egui::Ui, icon: Icon, size: f32, color: Color32) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    if ui.is_rect_visible(rect) {
        paint_icon(ui.painter(), rect, icon, color);
    }
    response
}

pub fn icon_button(ui: &mut egui::Ui, icon: Icon, tooltip: &str) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::click());
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), tooltip)
    });
    if ui.is_rect_visible(rect) {
        let visuals = ui.style().interact(&response);
        if response.hovered() || response.has_focus() || response.is_pointer_button_down_on() {
            ui.painter().rect_filled(rect, 8, visuals.weak_bg_fill);
        }
        paint_icon(
            ui.painter(),
            Rect::from_center_size(rect.center(), Vec2::splat(18.0)),
            icon,
            visuals.fg_stroke.color,
        );
        if response.has_focus() {
            ui.painter().rect_stroke(
                rect.shrink(1.0),
                8,
                Stroke::new(1.0_f32, visuals.fg_stroke.color),
                StrokeKind::Inside,
            );
        }
    }
    response.on_hover_text(tooltip)
}

pub fn nav_row(ui: &mut egui::Ui, icon: Icon, label: &str, selected: bool) -> Response {
    let width = ui.available_width().max(1.0);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, 34.0), Sense::click());
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::SelectableLabel,
            ui.is_enabled(),
            selected,
            label,
        )
    });
    if ui.is_rect_visible(rect) {
        let visuals = ui.style().interact_selectable(&response, selected);
        let fill = if selected {
            ui.visuals().selection.bg_fill
        } else if response.hovered() || response.has_focus() {
            visuals.weak_bg_fill
        } else {
            Color32::TRANSPARENT
        };
        ui.painter().rect_filled(rect, 7, fill);
        let color = if selected {
            ui.visuals().text_color()
        } else {
            visuals.fg_stroke.color
        };
        paint_icon(
            ui.painter(),
            Rect::from_center_size(
                Pos2::new(rect.left() + 18.0, rect.center().y),
                Vec2::splat(17.0),
            ),
            icon,
            color,
        );
        let job = egui::text::LayoutJob {
            text: label.to_owned(),
            sections: vec![egui::text::LayoutSection {
                leading_space: 0.0,
                byte_range: 0..label.len(),
                format: TextFormat {
                    font_id: FontId::proportional(13.0),
                    color,
                    ..Default::default()
                },
            }],
            wrap: egui::text::TextWrapping {
                max_width: (width - 44.0).max(0.0),
                max_rows: 1,
                break_anywhere: true,
                ..Default::default()
            },
            break_on_newline: false,
            ..Default::default()
        };
        let galley = ui.fonts_mut(|fonts| fonts.layout_job(job));
        let y = rect.center().y - galley.size().y * 0.5;
        ui.painter().with_clip_rect(rect.shrink(2.0)).galley(
            Pos2::new(rect.left() + 36.0, y),
            galley,
            color,
        );
        if response.has_focus() {
            ui.painter().rect_stroke(
                rect.shrink(1.0),
                7,
                Stroke::new(1.0_f32, color),
                StrokeKind::Inside,
            );
        }
    }
    response.on_hover_text(label)
}
