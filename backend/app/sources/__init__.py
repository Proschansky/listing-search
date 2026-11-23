"""Where listings come from.

Each source turns its own data into records in the app's feed format (the
dict ``Listing.from_dict`` validates), so everything after loading
(validation, duplicate merging, search, scoring) works the same for every
source. See ``base.py`` for the interface.
"""
