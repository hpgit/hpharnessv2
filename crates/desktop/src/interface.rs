use super::*;
use appearance::{Icon, icon, icon_button, nav_row};

fn visible_run<'a>(runs: &'a [Value], session: &str) -> Option<&'a Value> {
    runs.iter()
        .rev()
        .find(|r| {
            text(r, "sessionId") == session
                && matches!(
                    text(r, "status"),
                    "running" | "waiting_approval" | "waiting_child"
                )
        })
        .or_else(|| runs.iter().rev().find(|r| text(r, "sessionId") == session))
}

impl HarnessApp {
    pub(super) fn visuals(&self, ctx: &egui::Context) {
        appearance::apply(ctx, self.prefs.dark, self.prefs.solarized);
    }

    fn start_chat_dialog(&mut self) {
        if let Some(project) = self
            .projects
            .iter()
            .find(|p| text(p, "id") == self.prefs.selected_project)
        {
            self.new_root = text(project, "root").into();
            self.remote = text(&project["target"], "kind") == "ssh";
            self.new_host = text(&project["target"], "host").into();
            self.new_container = text(&project["target"], "container").into();
            self.new_session_open = true;
        } else {
            self.create_open = true;
        }
    }

    pub(super) fn sidebar(&mut self, ui: &mut egui::Ui) {
        let p = appearance::palette(self.prefs.dark, self.prefs.solarized);
        ui.horizontal(|ui| {
            icon(ui, Icon::Code, 23.0, p.text);
            ui.label(RichText::new("Harness").size(17.0).strong());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icon_button(ui, Icon::Panel, "사이드바 접기").clicked() {
                    self.prefs.sidebar_collapsed = true;
                }
            });
        });
        ui.add_space(21.0);
        if nav_row(ui, Icon::NewChat, "새 작업", false).clicked() {
            self.start_chat_dialog();
        }
        if nav_row(ui, Icon::Search, "작업 검색", self.search_open).clicked() {
            self.search_open = !self.search_open;
            if self.search_open {
                self.left_tab = 0;
                self.request("sessions.list", json!({}), Pending::AllSessions);
            } else {
                self.sidebar_query.clear();
            }
        }
        if self.search_open {
            ui.add(
                egui::TextEdit::singleline(&mut self.sidebar_query)
                    .hint_text("프로젝트 · 작업 검색")
                    .desired_width(f32::INFINITY),
            );
        }
        if nav_row(
            ui,
            Icon::Inbox,
            &if self.approvals.is_empty() {
                "응답 필요".into()
            } else {
                format!("응답 필요    {}", self.approvals.len())
            },
            self.bottom_open && self.bottom_tab == 1,
        )
        .clicked()
        {
            self.bottom_open = true;
            self.bottom_tab = 1;
        }
        ui.add_space(24.0);
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(if self.left_tab == 1 {
                    "파일"
                } else {
                    "프로젝트"
                })
                .color(p.muted)
                .size(12.0),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icon_button(ui, Icon::Plus, "프로젝트 추가").clicked() {
                    self.create_open = true;
                }
                if icon_button(
                    ui,
                    if self.left_tab == 1 {
                        Icon::Chat
                    } else {
                        Icon::Folder
                    },
                    "프로젝트 / 파일 전환",
                )
                .clicked()
                {
                    self.left_tab = 1 - self.left_tab;
                }
            });
        });
        let list_height = (ui.available_height() - 100.0).max(80.0);
        egui::ScrollArea::vertical()
            .id_salt("navigation-list")
            .auto_shrink([false, false])
            .max_height(list_height)
            .min_scrolled_height(list_height)
            .show(ui, |ui| {
                if self.left_tab == 1 {
                    self.file_navigation(ui);
                    return;
                }
                if self.projects.is_empty() {
                    ui.add_space(12.0);
                    ui.label(
                        RichText::new("프로젝트를 추가하고\n첫 작업을 시작하세요.").color(p.muted),
                    );
                }
                let filter = self.sidebar_query.to_lowercase();
                for project in self.projects.clone() {
                    let id = text(&project, "id").to_owned();
                    let selected = id == self.prefs.selected_project;
                    let project_sessions: Vec<Value> = if selected {
                        self.sessions.clone()
                    } else {
                        self.all_sessions
                            .iter()
                            .filter(|s| text(s, "projectId") == id)
                            .cloned()
                            .collect()
                    };
                    let matches = text(&project, "name").to_lowercase().contains(&filter);
                    if !filter.is_empty()
                        && !matches
                        && !project_sessions
                            .iter()
                            .any(|s| text(s, "title").to_lowercase().contains(&filter))
                    {
                        continue;
                    }
                    let expanded =
                        (selected && !self.collapsed_projects.contains(&id)) || !filter.is_empty();
                    if nav_row(
                        ui,
                        if expanded {
                            Icon::ChevronDown
                        } else {
                            Icon::ChevronRight
                        },
                        text(&project, "name"),
                        false,
                    )
                    .on_hover_text(text(&project, "root"))
                    .clicked()
                    {
                        self.left_tab = 0;
                        if selected {
                            if !self.collapsed_projects.remove(&id) {
                                self.collapsed_projects.insert(id.clone());
                            }
                        } else {
                            self.collapsed_projects.remove(&id);
                            self.select_project(id.clone());
                        }
                    }
                    if expanded {
                        ui.indent(("project-chats", &id), |ui| {
                            for session in &project_sessions {
                                if !filter.is_empty()
                                    && !matches
                                    && !text(session, "title").to_lowercase().contains(&filter)
                                {
                                    continue;
                                }
                                let sid = text(session, "id").to_owned();
                                let active = self.runs.iter().any(|r| {
                                    text(r, "sessionId") == sid
                                        && matches!(
                                            text(r, "status"),
                                            "running"
                                                | "waiting_approval"
                                                | "waiting_child"
                                                | "queued"
                                        )
                                });
                                if nav_row(
                                    ui,
                                    if active { Icon::More } else { Icon::Chat },
                                    text(session, "title"),
                                    sid == self.prefs.selected_session,
                                )
                                .clicked()
                                {
                                    if self.prefs.selected_project != id {
                                        self.select_project(id.clone());
                                        self.sessions = project_sessions.clone();
                                    }
                                    self.collapsed_projects.remove(&id);
                                    self.select_session(sid);
                                }
                            }
                            if project_sessions.is_empty() {
                                ui.label(
                                    RichText::new("아직 작업이 없습니다").small().color(p.muted),
                                );
                            }
                        });
                    }
                    ui.add_space(5.0);
                }
            });
        ui.add_space(12.0);
        if nav_row(ui, Icon::Memory, "기억", false).clicked() {
            self.memory_open = true;
            self.request(
                "memory.list",
                json!({"projectId":self.prefs.selected_project}),
                Pending::Memory,
            );
        }
        if nav_row(ui, Icon::Settings, "설정", self.settings_open).clicked() {
            self.settings_open = true;
        }
    }

    fn file_navigation(&mut self, ui: &mut egui::Ui) {
        let p = appearance::palette(self.prefs.dark, self.prefs.solarized);
        ui.add(
            egui::Label::new(
                RichText::new(if self.file_dir.is_empty() {
                    "프로젝트 폴더"
                } else {
                    &self.file_dir
                })
                .small()
                .color(p.muted),
            )
            .truncate(),
        )
        .on_hover_text(&self.file_dir);
        if nav_row(ui, Icon::Folder, "상위 폴더", false).clicked() {
            self.file_dir = self
                .file_dir
                .trim_end_matches(['/', '\\'])
                .rsplit_once(['/', '\\'])
                .map(|(p, _)| {
                    if p.ends_with(':') {
                        format!("{p}\\")
                    } else {
                        p.to_owned()
                    }
                })
                .unwrap_or_default();
            self.request(
                "files.list",
                json!({"sessionId":self.prefs.selected_session,"path":self.file_dir}),
                Pending::Files(self.prefs.selected_session.clone()),
            );
        }
        for file in self.files.clone() {
            let directory = file["isDirectory"].as_bool().unwrap_or(false);
            let path = text(&file, "path").to_owned();
            let selected = self
                .buffers
                .get(self.active_buffer)
                .is_some_and(|b| b.path == path && b.session == self.prefs.selected_session);
            if nav_row(
                ui,
                if directory { Icon::Folder } else { Icon::Code },
                text(&file, "name"),
                selected,
            )
            .clicked()
            {
                if directory {
                    self.file_dir = path.clone();
                    self.request(
                        "files.list",
                        json!({"sessionId":self.prefs.selected_session,"path":path}),
                        Pending::Files(self.prefs.selected_session.clone()),
                    );
                } else {
                    let extension = PathBuf::from(&path)
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase();
                    if ["png", "jpg", "jpeg", "gif", "webp"].contains(&extension.as_str()) {
                        self.request(
                            "files.preview",
                            json!({"sessionId":self.prefs.selected_session,"path":path}),
                            Pending::Preview,
                        );
                    } else if ["docx", "xlsx", "pptx", "pdf", "doc", "xls", "ppt"]
                        .contains(&extension.as_str())
                    {
                        self.preview_open = true;
                        self.preview_image = None;
                        self.preview_note="Office·PDF 미리보기는 아직 연결되지 않았습니다. DRM 문서는 사내 Office 환경의 검증이 필요합니다.".into();
                    } else {
                        self.request(
                            "files.read",
                            json!({"sessionId":self.prefs.selected_session,"path":path}),
                            Pending::Read(self.prefs.selected_session.clone()),
                        );
                    }
                }
            }
        }
    }

    pub(super) fn header(&mut self, ui: &mut egui::Ui) {
        let p = appearance::palette(self.prefs.dark, self.prefs.solarized);
        ui.horizontal(|ui| {
            if self.prefs.sidebar_collapsed
                && icon_button(ui, Icon::Panel, "사이드바 열기").clicked()
            {
                self.prefs.sidebar_collapsed = false;
            }
            let title = self
                .sessions
                .iter()
                .find(|s| text(s, "id") == self.prefs.selected_session)
                .map(|s| text(s, "title"))
                .unwrap_or("새 작업");
            ui.allocate_ui_with_layout(
                egui::vec2((ui.available_width() - 230.0).max(80.0), 32.0),
                egui::Layout::left_to_right(egui::Align::Center),
                |ui| {
                    ui.add(egui::Label::new(RichText::new(title).strong().size(14.0)).truncate());
                },
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icon_button(ui, Icon::Terminal, "실행 패널 열기 / 닫기").clicked() {
                    self.bottom_open = !self.bottom_open;
                }
                if !self.prefs.edit_mode {
                    let available = ui.ctx().available_rect().width() >= 880.0
                        && self
                            .buffers
                            .iter()
                            .any(|b| b.session == self.prefs.selected_session);
                    ui.add_enabled_ui(available, |ui| {
                        if icon_button(ui, Icon::Panel, "코드 미리보기 열기 / 닫기").clicked()
                        {
                            self.prefs.show_preview = !self.prefs.show_preview;
                        }
                    })
                    .response
                    .on_disabled_hover_text(
                        "현재 작업에서 파일을 열고 창 너비를 늘리면 미리보기를 사용할 수 있습니다.",
                    );
                }
                egui::Frame::new()
                    .fill(p.sidebar)
                    .corner_radius(8)
                    .inner_margin(3)
                    .show(ui, |ui| {
                        ui.allocate_ui_with_layout(
                            egui::vec2(100.0, 30.0),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| {
                                if ui.selectable_label(!self.prefs.edit_mode, "대화").clicked() {
                                    self.prefs.edit_mode = false;
                                    self.left_tab = 0;
                                }
                                if ui.selectable_label(self.prefs.edit_mode, "편집").clicked() {
                                    self.prefs.edit_mode = true;
                                    self.left_tab = 1;
                                }
                            },
                        );
                    });
            });
        });
    }

    pub(super) fn chat(&mut self, ui: &mut egui::Ui) {
        let p = appearance::palette(self.prefs.dark, self.prefs.solarized);
        let available = ui.available_rect_before_wrap();
        let width = (available.width() - 40.0).clamp(180.0, 760.0);
        let left = available.center().x - width / 2.0;
        let narrow = width < 450.0;
        let composer_height = if narrow { 164.0 } else { 150.0 };
        let footer = 22.0;
        let transcript_height = (available.height() - composer_height - footer - 14.0).max(60.0);
        let body_rect = egui::Rect::from_min_size(
            egui::pos2(left, available.top()),
            egui::vec2(width, transcript_height),
        );
        let latest = visible_run(&self.runs, &self.prefs.selected_session).cloned();
        let busy = latest.as_ref().is_some_and(|r| {
            matches!(
                text(r, "status"),
                "running" | "queued" | "waiting_approval" | "waiting_child"
            )
        });
        ui.scope_builder(egui::UiBuilder::new().max_rect(body_rect), |ui| {
            egui::ScrollArea::vertical()
                .id_salt(("conversation", &self.prefs.selected_session))
                .stick_to_bottom(true)
                .auto_shrink([false, false])
                .max_height(transcript_height)
                .min_scrolled_height(transcript_height)
                .show(ui, |ui| {
                    ui.set_width(width - 12.0);
                    if self.messages.is_empty() {
                        ui.add_space((transcript_height * 0.35).clamp(18.0, 220.0));
                        ui.vertical_centered(|ui| {
                            icon(ui, Icon::Code, 36.0, p.text);
                            ui.add_space(14.0);
                            ui.label(
                                RichText::new("무엇을 만들어 볼까요?")
                                    .size(if narrow { 23.0 } else { 29.0 })
                                    .strong(),
                            );
                            ui.add_space(8.0);
                            ui.label(
                                RichText::new(if self.prefs.selected_session.is_empty() {
                                    "프로젝트를 선택하고 새 작업을 시작하세요."
                                } else {
                                    "코드부터 문서까지, 이 작업 공간에서 함께."
                                })
                                .color(p.muted),
                            );
                            ui.add_space(22.0);
                            if self.prefs.selected_session.is_empty() {
                                if ui
                                    .button(if self.projects.is_empty() {
                                        "프로젝트 추가"
                                    } else {
                                        "새 작업 시작"
                                    })
                                    .clicked()
                                {
                                    self.start_chat_dialog();
                                }
                            } else {
                                ui.horizontal_wrapped(|ui| {
                                    for prompt in [
                                        "이 프로젝트를 설명해줘",
                                        "변경사항을 검토해줘",
                                        "다음 작업 계획을 세워줘",
                                    ] {
                                        if ui
                                            .add(
                                                egui::Button::new(prompt)
                                                    .stroke(egui::Stroke::new(1.0_f32, p.border))
                                                    .corner_radius(10),
                                            )
                                            .clicked()
                                        {
                                            self.composer = prompt.into();
                                        }
                                    }
                                });
                            }
                        });
                    }
                    for message in &self.messages {
                        ui.add_space(22.0);
                        let content = message
                            .get("content")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| message["content"].to_string());
                        match text(message, "role") {
                            "user" => {
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::TOP),
                                    |ui| {
                                        egui::Frame::new()
                                            .fill(p.bubble)
                                            .corner_radius(18)
                                            .inner_margin(egui::Margin::symmetric(16, 12))
                                            .show(ui, |ui| {
                                                ui.set_max_width((width * 0.84 - 32.0).max(100.0));
                                                ui.with_layout(
                                                    egui::Layout::top_down(egui::Align::Min),
                                                    |ui| {
                                                        ui.add(
                                                            egui::Label::new(&content)
                                                                .wrap()
                                                                .selectable(true),
                                                        );
                                                    },
                                                );
                                            });
                                    },
                                );
                            }
                            "assistant" => {
                                if !content.is_empty() {
                                    egui_commonmark::CommonMarkViewer::new().show(
                                        ui,
                                        &mut self.markdown,
                                        &content,
                                    );
                                }
                                if let Some(calls) = message["toolCalls"].as_array() {
                                    for call in calls {
                                        ui.horizontal(|ui| {
                                            icon(ui, Icon::Code, 14.0, p.muted);
                                            ui.label(
                                                RichText::new(text(call, "name"))
                                                    .color(p.muted)
                                                    .small(),
                                            );
                                        });
                                    }
                                }
                                if !content.is_empty() {
                                    ui.add_space(6.0);
                                    if icon_button(ui, Icon::Copy, "응답 복사").clicked() {
                                        ui.ctx().copy_text(content);
                                    }
                                }
                            }
                            "tool" => {
                                egui::CollapsingHeader::new(
                                    RichText::new("도구 실행 결과").small().color(p.muted),
                                )
                                .id_salt(text(message, "id"))
                                .show(ui, |ui| {
                                    ui.add(
                                        egui::Label::new(
                                            RichText::new(content).monospace().size(12.0),
                                        )
                                        .wrap()
                                        .selectable(true),
                                    );
                                });
                            }
                            _ => {
                                egui::CollapsingHeader::new("작업 맥락")
                                    .id_salt(text(message, "id"))
                                    .show(ui, |ui| {
                                        ui.add(egui::Label::new(content).wrap().selectable(true));
                                    });
                            }
                        }
                    }
                    if let Some(run) = &latest {
                        if busy {
                            ui.add_space(16.0);
                            ui.horizontal(|ui| {
                                ui.spinner();
                                ui.label(
                                    RichText::new(match text(run, "status") {
                                        "waiting_approval" => "승인을 기다리는 중",
                                        "waiting_child" => "하위 작업을 기다리는 중",
                                        "queued" => "다음 작업으로 예약됨",
                                        _ => "작업 중",
                                    })
                                    .color(p.muted),
                                );
                            });
                        }
                        if let Some(error) = run.get("error") {
                            ui.add_space(12.0);
                            ui.colored_label(
                                Color32::from_rgb(190, 60, 45),
                                error.as_str().unwrap_or("작업을 완료하지 못했습니다."),
                            );
                        }
                    }
                    ui.add_space(24.0);
                });
        });
        let composer_rect = egui::Rect::from_min_size(
            egui::pos2(left, available.top() + transcript_height + 12.0),
            egui::vec2(width, composer_height),
        );
        ui.scope_builder(egui::UiBuilder::new().max_rect(composer_rect), |ui| {
            egui::Frame::new()
                .fill(p.input)
                .stroke(egui::Stroke::new(1.0_f32, p.border))
                .corner_radius(20)
                .inner_margin(egui::Margin::symmetric(16, 12))
                .show(ui, |ui| {
                    ui.set_width(width - 34.0);
                    egui::ScrollArea::vertical()
                        .id_salt("composer-scroll")
                        .max_height(66.0)
                        .min_scrolled_height(66.0)
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::multiline(&mut self.composer)
                                    .id_salt("composer")
                                    .frame(false)
                                    .desired_width(f32::INFINITY)
                                    .desired_rows(3)
                                    .min_size(egui::vec2(0.0, 66.0))
                                    .hint_text(if busy {
                                        "추가로 요청하기 · 다음 작업으로 예약"
                                    } else {
                                        "무엇이든 요청하세요. Ctrl+Enter로 보내기"
                                    }),
                            );
                        });
                    ui.horizontal(|ui| {
                        if icon_button(ui, Icon::Plus, "파일과 도구").clicked() {
                            self.left_tab = 1;
                            self.prefs.sidebar_collapsed = false;
                        }
                        if ui
                            .add(
                                egui::Button::new(RichText::new(&self.model).size(12.0))
                                    .frame(false),
                            )
                            .on_hover_text("모델 연결 설정")
                            .clicked()
                        {
                            self.settings_open = true;
                        }
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let can_send = self.connected
                                && !self.prefs.selected_session.is_empty()
                                && !self.composer.trim().is_empty();
                            if busy && self.composer.trim().is_empty() {
                                if icon_button(ui, Icon::Stop, "현재 작업 중지").clicked()
                                    && let Some(run) = &latest
                                {
                                    self.request(
                                        "runs.cancel",
                                        json!({"runId":run["id"]}),
                                        Pending::Generic("작업 중지".into()),
                                    );
                                }
                            } else {
                                let (rect, response) = ui.allocate_exact_size(
                                    egui::vec2(30.0, 30.0),
                                    egui::Sense::click(),
                                );
                                ui.painter().circle_filled(
                                    rect.center(),
                                    15.0,
                                    if can_send { p.accent } else { p.selected },
                                );
                                let stroke = egui::Stroke::new(
                                    1.8_f32,
                                    if can_send { p.canvas } else { p.muted },
                                );
                                let c = rect.center();
                                ui.painter().line_segment(
                                    [c + egui::vec2(0.0, 6.0), c - egui::vec2(0.0, 6.0)],
                                    stroke,
                                );
                                ui.painter().line_segment(
                                    [c - egui::vec2(5.0, 1.0), c - egui::vec2(0.0, 6.0)],
                                    stroke,
                                );
                                ui.painter().line_segment(
                                    [c + egui::vec2(5.0, -1.0), c - egui::vec2(0.0, 6.0)],
                                    stroke,
                                );
                                if response.on_hover_text("보내기 · Ctrl+Enter").clicked()
                                    && can_send
                                {
                                    self.send_message();
                                }
                            }
                        });
                    });
                });
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                let session = self
                    .sessions
                    .iter()
                    .find(|s| text(s, "id") == self.prefs.selected_session);
                let location = session
                    .map(|s| {
                        let target = &s["target"];
                        if text(target, "kind") == "ssh" {
                            format!("SSH · {}", text(target, "host"))
                        } else {
                            "로컬".into()
                        }
                    })
                    .unwrap_or_else(|| "프로젝트를 선택하세요".into());
                icon(ui, Icon::Folder, 12.0, p.muted);
                ui.add(egui::Label::new(RichText::new(location).small().color(p.muted)).truncate())
                    .on_hover_text(
                        session
                            .map(|s| {
                                format!("{}\n{}", text(s, "cwd"), text(&s["target"], "container"))
                            })
                            .unwrap_or_default(),
                    );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        RichText::new(if self.connected {
                            "연결됨"
                        } else {
                            "연결 중"
                        })
                        .small()
                        .color(p.muted),
                    );
                });
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn displayed_status_prefers_active_work_over_queued_or_old_completed_runs() {
        let runs = vec![
            json!({"id":"old","sessionId":"a","status":"completed"}),
            json!({"id":"active","sessionId":"a","status":"running"}),
            json!({"id":"queued","sessionId":"a","status":"queued"}),
            json!({"id":"other","sessionId":"b","status":"running"}),
        ];
        assert_eq!(visible_run(&runs, "a").unwrap()["id"], "active");
        assert!(visible_run(&runs, "missing").is_none());
        let waiting = vec![
            json!({"id":"parent","sessionId":"a","status":"waiting_child"}),
            runs[2].clone(),
        ];
        assert_eq!(visible_run(&waiting, "a").unwrap()["id"], "parent");
    }
    #[test]
    fn old_preferences_preserve_workspace_selection_when_theme_fields_are_added() {
        let prefs:Preferences=serde_json::from_value(json!({"edit_mode":true,"dark":true,"selected_project":"existing","selected_session":"chat"})).unwrap();
        assert!(prefs.dark && prefs.edit_mode);
        assert_eq!(prefs.selected_project, "existing");
        assert!(!prefs.solarized && !prefs.sidebar_collapsed);
    }
}
