package store

import "context"

type Tag struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
type DirectoryTag struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Letter string `json:"letter"`
}
type TagGroup struct {
	Letter string `json:"letter"`
	Count  int    `json:"count"`
}
type TagDirectory struct {
	Tags     []DirectoryTag `json:"tags"`
	Groups   []TagGroup     `json:"groups"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
}

func (s *Store) Tags(ctx context.Context) ([]Tag, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT value,COUNT(*) FROM links,json_each(links.tags) GROUP BY value ORDER BY COUNT(*) DESC,value LIMIT 200")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Tag{}
	for rows.Next() {
		var item Tag
		if err = rows.Scan(&item.Name, &item.Count); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (s *Store) BrowseTags(ctx context.Context, query string, page int, jump string) (TagDirectory, error) {
	const pageSize = 40
	const source = " FROM links,json_each(links.tags) WHERE instr(lower(value),lower(?)) > 0"
	const initial = "CASE WHEN upper(substr(value,1,1)) BETWEEN 'A' AND 'Z' THEN upper(substr(value,1,1)) ELSE '#' END"
	const order = "CASE WHEN letter = '#' THEN 1 ELSE 0 END,letter"
	groupsRows, err := s.db.QueryContext(ctx, "SELECT "+initial+" AS letter,COUNT(DISTINCT value)"+source+" GROUP BY letter ORDER BY "+order, query)
	if err != nil {
		return TagDirectory{}, err
	}
	groups := []TagGroup{}
	total := 0
	for groupsRows.Next() {
		var item TagGroup
		if err := groupsRows.Scan(&item.Letter, &item.Count); err != nil {
			groupsRows.Close()
			return TagDirectory{}, err
		}
		if item.Letter == jump {
			page = total/pageSize + 1
		}
		total += item.Count
		groups = append(groups, item)
	}
	err = groupsRows.Err()
	groupsRows.Close()
	if err != nil {
		return TagDirectory{}, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT value,COUNT(*),"+initial+" AS letter"+source+" GROUP BY value ORDER BY "+order+",value COLLATE NOCASE,value LIMIT ? OFFSET ?", query, pageSize, (page-1)*pageSize)
	if err != nil {
		return TagDirectory{}, err
	}
	defer rows.Close()
	tags := []DirectoryTag{}
	for rows.Next() {
		var item DirectoryTag
		if err := rows.Scan(&item.Name, &item.Count, &item.Letter); err != nil {
			return TagDirectory{}, err
		}
		tags = append(tags, item)
	}
	if err := rows.Err(); err != nil {
		return TagDirectory{}, err
	}
	return TagDirectory{Tags: tags, Groups: groups, Total: total, Page: page, PageSize: pageSize}, nil
}
