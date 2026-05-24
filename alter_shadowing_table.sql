-- Sửa lỗi PostgreSQL với cột items trong bảng shadowing
-- 1. Thay đổi kiểu dữ liệu cột items từ JSONB[] thành JSONB

ALTER TABLE shadowing ALTER COLUMN items TYPE JSONB;

-- 2. Câu INSERT mẫu (nếu cần insert thủ công)
-- Thay vì dùng ARRAY[...] syntax, dùng JSON string cho array

-- Ví dụ INSERT:
INSERT INTO shadowing (id, title, items, isPublished)
VALUES (
  's_1234567890',
  'Bài học mẫu',
  '[{"jp": "こんにちは", "romaji": "konnichiwa", "vi": "Xin chào", "en": "Hello"}]'::jsonb,
  true
);

-- 3. Code JavaScript hiện tại vẫn tương thích
-- Supabase client sẽ tự động serialize array JavaScript thành JSON string
-- Không cần thay đổi code trong App.jsx

-- 4. Insert dữ liệu mẫu cho bảng shadowing
INSERT INTO shadowing (id, level, type, title, isPublished, items) VALUES
('s1', 'N5', 'vocab', 'Chủ đề: Trường học & Học tập', true, '[{"jp": "[学校|がっこう]", "romaji": "Gakkou", "vi": "Trường học", "en": "School"}, {"jp": "[学生|がくせい]", "romaji": "Gakusei", "vi": "Học sinh", "en": "Student"}, {"jp": "[先生|せんせい]", "romaji": "Sensei", "vi": "Giáo viên", "en": "Teacher"}, {"jp": "[教室|きょうしつ]", "romaji": "Kyoushitsu", "vi": "Phòng học", "en": "Classroom"}, {"jp": "[本|ほん]", "romaji": "Hon", "vi": "Sách", "en": "Book"}]'::jsonb),
('s2', 'N5', 'sentence', 'Bài 1: Giao tiếp hàng ngày', true, '[{"jp": "おはようございます。", "romaji": "Ohayou gozaimasu.", "vi": "Chào buổi sáng.", "en": "Good morning."}, {"jp": "お[元気|げんき]ですか。", "romaji": "O-genki desu ka.", "vi": "Bạn có khỏe không?", "en": "How are you?"}, {"jp": "[週末|しゅうまつ]は[友達|ともだち]と[映画|えいが]を[見|み]に[行|い]きます。", "romaji": "Shuumatsu wa tomodachi to eiga o mi ni ikimasu.", "vi": "Cuối tuần tôi sẽ đi xem phim với bạn.", "en": "I will go see a movie with a friend this weekend."}]'::jsonb);