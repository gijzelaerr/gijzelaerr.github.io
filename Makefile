
ALL: run
.PHONY: run


run:
	bundle exec jekyll serve

update:
	bundle update


install:
	bundle install